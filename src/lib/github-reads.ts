/**
 * gh 工具的 REST 读取层：把「按 owner/repo/编号取数据」这一件事集中在这里，让工具文件
 * 只关心渲染与载荷（与 `createGithubSearch` / `createGithubChecks` 并列）。
 *
 * 与 `gh … --json` 的差别：字段名是 GitHub REST 的（`html_url` / `closed_at` / `user.login`），
 * 工具因此直接把响应原物给模型与结构化载荷，不再有 GraphQL 形状的中间层。
 *
 * 认证、代理与 401 重试都由 `createGithubApi` 承担（同一个缓存 client）；二进制下载走
 * `rawFetch`，因为 octokit 会把响应体按 JSON 解析。
 */

import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Octokit } from "octokit";

import { createGithubApi, type GithubClientOptions } from "./github.js";

/** `actions.listWorkflowRuns*` 的 `status` 取值（octokit 是字面量联合，工具参数是 string）。 */
type WorkflowRunParams = NonNullable<
  Parameters<Octokit["rest"]["actions"]["listWorkflowRunsForRepo"]>[0]
>;
type WorkflowRunStatus = NonNullable<WorkflowRunParams["status"]>;

/** 列表类查询的公共过滤条件；与工具的 `ListFilters` 一一对应。 */
export interface ListQuery {
  state?: string;
  label?: string;
  author?: string;
  assignee?: string;
  milestone?: string;
  limit?: number;
}

export interface GithubReads {
  issue(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<unknown>;
  pull(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<unknown>;
  issueComments(
    owner: string,
    repo: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  pullReviewComments(
    owner: string,
    repo: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  pullReviews(
    owner: string,
    repo: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  listIssues(
    owner: string,
    repo: string,
    query: ListQuery,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  listPulls(
    owner: string,
    repo: string,
    query: ListQuery,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  pullDiff(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<string>;
  listReleases(
    owner: string,
    repo: string,
    limit: number | undefined,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  /** `tag` 缺省时取 latest release（与 `gh release view` 的缺省一致）。 */
  release(
    owner: string,
    repo: string,
    tag: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown>;
  listRuns(
    owner: string,
    repo: string,
    query: { workflow?: string; status?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  run(owner: string, repo: string, runId: number, signal?: AbortSignal): Promise<unknown>;
  repository(owner: string, repo: string, signal?: AbortSignal): Promise<unknown>;
  /** job 的原始日志文本（GitHub 只有按 job id 取日志的端点）。 */
  jobLogs(owner: string, repo: string, jobId: number, signal?: AbortSignal): Promise<string>;
  /** 下载一个 release 资产到 `destPath`（流式，不整体驻留内存）。 */
  downloadAssetTo(
    owner: string,
    repo: string,
    assetId: number,
    destPath: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** 下载仓库源码归档（`gh release download --archive` 的对应物）。 */
  downloadArchiveTo(
    owner: string,
    repo: string,
    format: "zip" | "tar.gz",
    ref: string | undefined,
    destPath: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** REST 列表查询把工具的 state 过滤映射成 `state` 参数（issue/PR 的值集合相同）。 */
function stateParam(state: string | undefined): "open" | "closed" | "all" | undefined {
  if (state === undefined || state === "all") {
    return state === "all" ? "all" : undefined;
  }
  if (state === "open" || state === "closed") {
    return state;
  }
  // merged 只对搜索路径有意义（列表端点没有这个状态），列表侧按 all 处理
  if (state === "merged") {
    return "all";
  }
  throw new Error(`invalid state: ${state} (expected open, closed, all)`);
}

/** `@me` 是 gh CLI 的简写，REST 列表端点不认识；按字面量转发（用户明确不做展开）。 */
function listParams(query: ListQuery): {
  state?: "open" | "closed" | "all";
  labels?: string;
  assignee?: string;
  creator?: string;
  milestone?: string;
} {
  const state = stateParam(query.state);
  return {
    ...(state !== undefined && { state }),
    ...(query.label !== undefined && { labels: query.label }),
    ...(query.assignee !== undefined && { assignee: query.assignee }),
    ...(query.author !== undefined && { creator: query.author }),
    ...(query.milestone !== undefined && { milestone: query.milestone }),
  };
}

function limitOf(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(limit ?? fallback, 1), 100);
}

/** 响应体不是 2xx 时抛错（状态、URL 与 GitHub 的 message 都在里面）。 */
async function ensureOk(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  let detail: string | undefined;
  try {
    const body = await response.text();
    detail = (JSON.parse(body) as { message?: string }).message ?? body.slice(0, 200);
  } catch {
    detail = undefined;
  }
  throw new Error(
    `GitHub API error (HTTP ${response.status}) at ${response.url}${detail === undefined || detail === "" ? "" : `: ${detail}`}`,
  );
}

function octokitRequest(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

/** 把 octokit 的类型化 data 当外部 JSON 交出去：调用方用 schema 校验自己读的字段。 */
function asJson(value: unknown): unknown {
  return value;
}

export function createGithubReads(options: GithubClientOptions = {}): GithubReads {
  const api = createGithubApi(options);

  return {
    async issue(owner, repo, number, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.issues.get({ owner, repo, issue_number: number, ...octokitRequest(signal) }),
      );
      return asJson(data);
    },

    async pull(owner, repo, number, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.pulls.get({ owner, repo, pull_number: number, ...octokitRequest(signal) }),
      );
      return asJson(data);
    },

    async issueComments(owner, repo, number, signal) {
      const data = await api.call((octokit) =>
        octokit.paginate(octokit.rest.issues.listComments, {
          owner,
          repo,
          issue_number: number,
          per_page: 100,
          ...octokitRequest(signal),
        }),
      );
      return data.map((item) => asJson(item));
    },

    async pullReviewComments(owner, repo, number, signal) {
      const data = await api.call((octokit) =>
        octokit.paginate(octokit.rest.pulls.listReviewComments, {
          owner,
          repo,
          pull_number: number,
          per_page: 100,
          ...octokitRequest(signal),
        }),
      );
      return data.map((item) => asJson(item));
    },

    async pullReviews(owner, repo, number, signal) {
      const data = await api.call((octokit) =>
        octokit.paginate(octokit.rest.pulls.listReviews, {
          owner,
          repo,
          pull_number: number,
          per_page: 100,
          ...octokitRequest(signal),
        }),
      );
      return data.map((item) => asJson(item));
    },

    async listIssues(owner, repo, query, signal) {
      const limit = limitOf(query.limit, 30);
      const data = await api.call((octokit) =>
        octokit.paginate(octokit.rest.issues.listForRepo, {
          owner,
          repo,
          per_page: limit,
          ...listParams(query),
          ...octokitRequest(signal),
        }),
      );
      // 列表端点混着 PR（REST 的 issues 列表包含 PR），与 gh issue list 一致地过滤掉
      const issues = data.filter((item) => !("pull_request" in item));
      return issues.slice(0, limit).map((item) => asJson(item));
    },

    async listPulls(owner, repo, query, signal) {
      const limit = limitOf(query.limit, 30);
      const data = await api.call((octokit) =>
        octokit.paginate(octokit.rest.pulls.list, {
          owner,
          repo,
          per_page: limit,
          ...listParams(query),
          ...octokitRequest(signal),
        }),
      );
      return data.slice(0, limit).map((item) => asJson(item));
    },

    async pullDiff(owner, repo, number, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: number,
          mediaType: { format: "diff" },
          ...octokitRequest(signal),
        }),
      );
      // diff 媒体类型下 data 是原始 diff 文本；octokit 的类型仍按 JSON 声明，所以这里
      // 显式断言而不是把对象 stringify（[object Object] 会静默毁掉 diff）
      return data as unknown as string;
    },

    async listReleases(owner, repo, limit, signal) {
      const data = await api.call((octokit) =>
        octokit.paginate(octokit.rest.repos.listReleases, {
          owner,
          repo,
          per_page: limitOf(limit, 10),
          ...octokitRequest(signal),
        }),
      );
      return data.map((item) => asJson(item));
    },

    async release(owner, repo, tag, signal) {
      const { data } = await api.call((octokit) =>
        tag === undefined
          ? octokit.rest.repos.getLatestRelease({ owner, repo, ...octokitRequest(signal) })
          : octokit.rest.repos.getReleaseByTag({ owner, repo, tag, ...octokitRequest(signal) }),
      );
      return asJson(data);
    },

    async listRuns(owner, repo, query, signal) {
      const limit = limitOf(query.limit, 20);
      let workflowId: number | undefined;
      if (query.workflow !== undefined) {
        const workflows = await api.call((octokit) =>
          octokit.paginate(octokit.rest.actions.listRepoWorkflows, {
            owner,
            repo,
            per_page: 100,
            ...octokitRequest(signal),
          }),
        );
        const wanted = query.workflow.toLowerCase();
        const match = workflows.find(
          (workflow) =>
            workflow.name.toLowerCase() === wanted ||
            workflow.path.toLowerCase() === wanted ||
            workflow.path.toLowerCase().endsWith(`/${wanted}`),
        );
        if (match === undefined) {
          const names = workflows.map((workflow) => workflow.name).join(", ");
          throw new Error(`workflow "${query.workflow}" not found (available: ${names})`);
        }
        workflowId = match.id;
      }
      const data = await api.call(async (octokit) => {
        const params = {
          owner,
          repo,
          per_page: limit,
          // REST 的 status 同时接受运行状态与结论（success / failure / in_progress …）；
          // octokit 把取值声明成字面量联合，这里按它的类型断言（非法取值由 API 报 422）
          ...(query.status !== undefined && { status: query.status as WorkflowRunStatus }),
          ...octokitRequest(signal),
        };
        return workflowId === undefined
          ? octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, params)
          : octokit.paginate(octokit.rest.actions.listWorkflowRuns, {
              ...params,
              workflow_id: workflowId,
            });
      });
      return data.slice(0, limit).map((item) => asJson(item));
    },

    async run(owner, repo, runId, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.actions.getWorkflowRun({
          owner,
          repo,
          run_id: runId,
          ...octokitRequest(signal),
        }),
      );
      return asJson(data);
    },

    async repository(owner, repo, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.repos.get({ owner, repo, ...octokitRequest(signal) }),
      );
      return asJson(data);
    },

    async jobLogs(owner, repo, jobId, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.actions.downloadJobLogsForWorkflowRun({
          owner,
          repo,
          job_id: jobId,
          ...octokitRequest(signal),
        }),
      );
      // 日志端点的响应体是文本；octokit 的类型是 `unknown`（按响应内容而定），这里断言
      return data as string;
    },

    async downloadAssetTo(owner, repo, assetId, destPath, signal) {
      const response = await api.rawFetch(
        `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`,
        { headers: { accept: "application/octet-stream" }, ...(signal && { signal }) },
      );
      await ensureOk(response);
      await streamToFile(response, destPath);
    },

    async downloadArchiveTo(owner, repo, format, ref, destPath, signal) {
      const kind = format === "zip" ? "zipball" : "tarball";
      const suffix = ref === undefined ? "" : `/${ref}`;
      const response = await api.rawFetch(
        `https://api.github.com/repos/${owner}/${repo}/${kind}${suffix}`,
        { ...(signal && { signal }) },
      );
      await ensureOk(response);
      await streamToFile(response, destPath);
    },
  };
}

/** 把响应体流式写入文件；响应没有 body（空资产）时写空文件。 */
async function streamToFile(response: Response, destPath: string): Promise<void> {
  const body = response.body;
  if (body === null) {
    await pipeline(Readable.from([]), createWriteStream(destPath));
    return;
  }
  await pipeline(Readable.fromWeb(body), createWriteStream(destPath));
}
