/**
 * GitHub search client built on octokit, authenticated with the token from the
 * system `gh` CLI (`gh auth token`). Used by the gh-readonly search tools.
 *
 * Unlike the `gh search` CLI, the search API has no `--state all` and treats a
 * merged PR's state as `closed` — so merged/closed disambiguation is expressed
 * through qualifiers here (`is:merged`, `state:closed -is:merged`) and the
 * rendered state is derived from `pull_request.merged_at`.
 */

import { Octokit } from "octokit";
import { type Static, Type } from "typebox";

import { ghAuthToken } from "./gh-process.js";
import { parseWithSchema } from "./parse-with-schema.js";

export type SearchKind = "issue" | "pr";

export interface SearchParams {
  repo?: string;
  keywords?: string;
  state?: string;
  label?: string;
  author?: string;
  assignee?: string;
  milestone?: string;
  limit?: number;
}

/**
 * REST /search/issues 里本客户端消费的 item 形状（issue / PR 联合）。只声明真正
 * 读取的字段，其余键忽略；未声明的字段类型不符时按「响应形状变了」处理，报错而
 * 不是把 undefined 混进结果。labels 兼容字符串与 {name} 两种形态（openapi 里是
 * 联合类型）。
 */
const searchItemSchema = Type.Object({
  number: Type.Number(),
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  title: Type.String(),
  html_url: Type.String(),
  /** The search API exposes the repo as a URL, not as an object. */
  repository_url: Type.String(),
  user: Type.Union([Type.Object({ login: Type.String() }), Type.Null()]),
  labels: Type.Array(
    Type.Union([Type.String(), Type.Object({ name: Type.Optional(Type.String()) })]),
  ),
  milestone: Type.Union([Type.Object({ title: Type.Optional(Type.String()) }), Type.Null()]),
  assignees: Type.Array(Type.Object({ login: Type.String() })),
  comments: Type.Number(),
  created_at: Type.String(),
  updated_at: Type.String(),
  closed_at: Type.Union([Type.String(), Type.Null()]),
  pull_request: Type.Union([
    Type.Object({ merged_at: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
    Type.Null(),
  ]),
});

type SearchItem = Static<typeof searchItemSchema>;

export interface SearchHit {
  number: number;
  /** `open`, `closed` or `merged` (merged is inferred from pull_request.merged_at). */
  state: "open" | "closed" | "merged";
  title: string;
  url: string;
  repo: string;
  author: string;
  labels: string[];
  milestone: string;
  assignees: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string;
  mergedAt: string;
}

/**
 * Build the `q` parameter for the issues-and-pull-requests search endpoint.
 *
 * State semantics (the whole reason this client exists):
 * - default is `open`, matching the browse tools
 * - `all` applies no state filter (open + closed)
 * - for PRs, `merged` maps to `is:merged` and `closed` excludes merged PRs,
 *   because the search API reports a merged PR's state as `closed`
 */
export function buildSearchQuery(kind: SearchKind, params: SearchParams): string {
  const { repo, keywords, label, author, assignee, milestone } = params;
  const state = params.state ?? "open";

  const parts: string[] = [];
  if (repo) {
    parts.push(`repo:${repo}`);
  }
  parts.push(kind === "issue" ? "is:issue" : "is:pr");
  switch (state) {
    case "open": {
      parts.push("state:open");

      break;
    }
    case "closed": {
      parts.push(kind === "pr" ? "state:closed -is:merged" : "state:closed");

      break;
    }
    case "merged": {
      if (kind === "issue") {
        throw new Error("state=merged is only valid for PR searches");
      }
      parts.push("is:merged");

      break;
    }
    default: {
      if (state !== "all") {
        throw new Error(
          `invalid state: ${state} (expected open, closed, ${kind === "pr" ? "merged, " : ""}all)`,
        );
      }
    }
  }
  if (keywords) {
    parts.push(keywords);
  }
  if (label) {
    parts.push(`label:${quoteQualifier(label)}`);
  }
  if (author) {
    parts.push(`author:${author}`);
  }
  if (assignee) {
    parts.push(`assignee:${assignee}`);
  }
  if (milestone) {
    parts.push(`milestone:${quoteQualifier(milestone)}`);
  }
  return parts.join(" ");
}

/** Quote a qualifier value that contains whitespace or special characters. */
function quoteQualifier(value: string): string {
  if (/^[\w@./-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', String.raw`\"`)}"`;
}

const FIELD_EXTRACTORS: Record<string, (hit: SearchHit) => string> = {
  number: (h) => String(h.number),
  state: (h) => h.state,
  title: (h) => h.title,
  url: (h) => h.url,
  repo: (h) => h.repo,
  author: (h) => h.author,
  labels: (h) => h.labels.join(","),
  milestone: (h) => h.milestone,
  assignees: (h) => h.assignees.join(","),
  comments: (h) => String(h.comments),
  createdAt: (h) => h.createdAt,
  updatedAt: (h) => h.updatedAt,
  closedAt: (h) => h.closedAt,
  mergedAt: (h) => h.mergedAt,
};

export const SEARCH_FIELDS: readonly string[] = Object.keys(FIELD_EXTRACTORS);

/** Render search hits as tab-separated rows; one row per hit, one column per field. */
export function renderHits(hits: SearchHit[], options: { repo?: string; fields?: string }): string {
  const requested = options.fields
    ? options.fields
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : options.repo
      ? ["number", "state", "title", "labels", "updatedAt"]
      : ["repo", "number", "state", "title", "labels", "updatedAt"];
  const unknown = requested.filter((f) => !(f in FIELD_EXTRACTORS));
  if (unknown.length > 0) {
    throw new Error(
      `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (valid: ${SEARCH_FIELDS.join(", ")})`,
    );
  }
  return hits.map((hit) => requested.map((f) => FIELD_EXTRACTORS[f](hit)).join("\t")).join("\n");
}

function toDate(iso: string | null | undefined): string {
  return dateOnly(iso);
}

/** ISO 时间戳取日期部分（`2026-10-03`）；缺省或 null 给空串。 */
export function dateOnly(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

const REPO_URL_RE = /\/repos\/([^/]+\/[^/]+)$/;

/** repository_url looks like https://api.github.com/repos/OWNER/REPO */
function repoName(raw: SearchItem): string {
  const match = REPO_URL_RE.exec(raw.repository_url);
  return match?.[1] ?? "";
}

function normalize(raw: SearchItem): SearchHit {
  const mergedAt = raw.pull_request?.merged_at ?? "";
  return {
    number: raw.number,
    state: mergedAt ? "merged" : raw.state,
    title: raw.title,
    url: raw.html_url,
    repo: repoName(raw),
    author: raw.user?.login ?? "",
    labels: raw.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))),
    milestone: raw.milestone?.title ?? "",
    assignees: raw.assignees.map((a) => a.login),
    comments: raw.comments,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    closedAt: toDate(raw.closed_at),
    mergedAt: toDate(mergedAt),
  };
}

/**
 * REST 列表端点（`issues.listForRepo` / `pulls.list`）的条目形状。与搜索 API 的条目差别：
 * repo 不在条目里（由调用方给），PR 的合并信息在 `merged_at`/`merged`。
 */
const restListItemSchema = Type.Object({
  number: Type.Number(),
  state: Type.String(),
  title: Type.String(),
  html_url: Type.String(),
  user: Type.Union([Type.Object({ login: Type.String() }), Type.Null()]),
  labels: Type.Array(Type.Object({ name: Type.Optional(Type.String()) })),
  milestone: Type.Union([Type.Object({ title: Type.Optional(Type.String()) }), Type.Null()]),
  assignees: Type.Union([Type.Array(Type.Object({ login: Type.String() })), Type.Null()]),
  comments: Type.Optional(Type.Number()),
  created_at: Type.String(),
  updated_at: Type.String(),
  closed_at: Type.Union([Type.String(), Type.Null()]),
  merged_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/**
 * 把 REST 列表条目归一到 `SearchHit`，与搜索分支共用一套渲染与载荷。`repo` 由调用方给
 * （REST 列表端点的条目里没有仓库信息）。
 */
export function normalizeRestList(items: unknown, repo: string): SearchHit[] {
  return parseWithSchema(Type.Array(restListItemSchema), items).map((item) => {
    const mergedAt = item.merged_at ?? null;
    return {
      number: item.number,
      // 已合并的 PR 在 REST 里也是 `closed`，merged 语义与搜索分支一致地由 merged_at 推断
      state: mergedAt === null ? (item.state === "open" ? "open" : "closed") : "merged",
      title: item.title,
      url: item.html_url,
      repo,
      author: item.user?.login ?? "",
      labels: item.labels.map((label) => label.name ?? ""),
      milestone: item.milestone?.title ?? "",
      assignees: (item.assignees ?? []).map((assignee) => assignee.login),
      comments: item.comments ?? 0,
      createdAt: toDate(item.created_at),
      updatedAt: toDate(item.updated_at),
      closedAt: toDate(item.closed_at),
      mergedAt: toDate(mergedAt),
    };
  });
}

/**
 * Error thrown when the GitHub search API rejects the request. Carries the
 * original toolcall params so the model can see the exact input.
 */
class GithubSearchError extends Error {
  readonly params: SearchParams;
  readonly status: number | undefined;

  constructor(message: string, params: SearchParams, status?: number) {
    super(`${message} (input: ${JSON.stringify(params)})`);
    this.name = "GithubSearchError";
    this.params = params;
    this.status = status;
  }
}

function describeHttpError(status: number | undefined): string {
  if (status === 401) {
    return 'GitHub auth failed (401): token invalid or expired — run "gh auth login"';
  }
  if (status === 403) {
    return "GitHub rate limit or permissions error (403)";
  }
  if (status === 404) {
    return "repository not found, or the token has no access to it (404)";
  }
  return `GitHub API error${status === undefined ? "" : ` (HTTP ${status})`}`;
}

export interface GithubApi {
  /** Run an octokit request; retries once with a fresh token on 401. */
  call<T>(fn: (octokit: Octokit) => Promise<T>): Promise<T>;
  /**
   * 用同一个 token 直接 fetch（二进制资产、源码归档这类要走原始响应体、不能经 octokit
   * 的 JSON 解析的请求）。重定向自动跟随，401 同样丢缓存重试一次。
   */
  rawFetch(url: string, init: RequestInit): Promise<Response>;
}

export interface GithubClientOptions {
  /**
   * Custom fetch for octokit's `request.fetch` hook — octokit v5 drops the old
   * `agent` option, so a proxy has to arrive as a fetch implementation with a
   * proxy dispatcher attached. Defaults to the global fetch.
   */
  fetch?: typeof globalThis.fetch;
  /** gh token provider；缺省读系统 `gh auth token`（见 lib/gh-process.ts）。 */
  token?: () => Promise<string>;
}

/**
 * Create a shared octokit accessor. The client (and its auth token) is cached
 * in the returned closure, so repeated calls reuse the same client without
 * module-level state. A stale cached token can produce 401s; the cache is
 * dropped and the request retried once in that case.
 */
export function createGithubApi(options: GithubClientOptions = {}): GithubApi {
  let client: Octokit | undefined;
  // token 单独缓存：rawFetch（二进制/归档下载）不走 octokit，但同样不该每次 spawn
  // `gh auth token`。401 时两个缓存一起丢。
  let token: string | undefined;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const tokenProvider = options.token ?? ghAuthToken;

  async function getToken(): Promise<string> {
    token ??= await tokenProvider();
    return token;
  }

  async function getClient(): Promise<Octokit> {
    client ??= new Octokit({
      auth: await getToken(),
      ...(options.fetch && { request: { fetch: options.fetch } }),
    });
    return client;
  }

  async function rawFetchOnce(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await getToken()}`);
    headers.set("accept", "application/vnd.github+json");
    headers.set("x-github-api-version", "2022-11-28");
    const response = await fetchImpl(url, { ...init, headers });
    if (response.status === 401) {
      // 缓存的 token 可能已过期：丢缓存后由调用方重试一次
      token = undefined;
      client = undefined;
    }
    return response;
  }

  return {
    async call(fn) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await fn(await getClient());
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 401 && attempt === 0 && client) {
            token = undefined;
            client = undefined;
            continue;
          }
          throw error;
        }
      }
    },

    async rawFetch(url, init) {
      for (let attempt = 0; ; attempt += 1) {
        const response = await rawFetchOnce(url, init);
        if (response.status !== 401 || attempt > 0) {
          return response;
        }
        await response.body?.cancel();
      }
    },
  };
}

export interface GithubSearch {
  search(kind: SearchKind, params: SearchParams): Promise<SearchHit[]>;
}

/**
 * Create a search client backed by a cached octokit instance.
 */
export function createGithubSearch(options: GithubClientOptions = {}): GithubSearch {
  const api = createGithubApi(options);

  return {
    async search(kind, params) {
      const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);

      try {
        // `@me` 是 gh CLI 的简写，REST 搜索不认识：这里不展开，带关键词时它按字面量
        // 进入查询串（无关键词的列表走 gh CLI，由 gh 自己展开）。
        const q = buildSearchQuery(kind, { ...params, limit });
        return await api.call(async (client) => {
          const { data } = await client.rest.search.issuesAndPullRequests({
            q,
            per_page: limit,
          });
          return data.items.map((item) => normalize(parseWithSchema(searchItemSchema, item)));
        });
      } catch (error) {
        const status = (error as { status?: number }).status;
        const message = (error as { message?: string }).message ?? String(error);
        throw new GithubSearchError(`${describeHttpError(status)}: ${message}`, params, status);
      }
    },
  };
}

/** One entry of the combined status API for a commit (classic commit status). */
export interface CommitStatus {
  readonly context: string;
  readonly state: string;
  readonly targetUrl: string | null;
}

/** One check run of the check-runs API for a commit (GitHub Actions, GitHub Apps). */
export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly url: string | null;
  /** Triggering workflow event (push, pull_request, ...); null when unknown. */
  readonly event: string | null;
  /** Actions workflow run id parsed from `details_url`; null for non-Actions checks. */
  readonly runId: number | null;
  /** Actions job id parsed from `details_url`; null when the check is run- not job-level. */
  readonly jobId: number | null;
}

/** One Actions job flattened with its workflow run metadata. */
export interface ActionJob {
  readonly runId: number;
  readonly runName: string;
  readonly runUrl: string;
  readonly jobId: number;
  readonly jobName: string;
  readonly conclusion: string | null;
  readonly jobUrl?: string;
}

/** One step of a workflow run job, as the REST API reports it. */
interface RunJobStep {
  readonly name: string;
  readonly number: number;
  readonly status: string;
  readonly conclusion: string | null;
  /** ISO-8601 UTC, second precision; null/absent for steps that never started. */
  readonly started_at?: string | null;
}

/**
 * One job of a workflow run. Field names mirror the REST API because the CI log
 * index consumes them as they arrive: `run_url`/`run_id` locate the job's raw
 * log file, `steps` give the step list to align against that log.
 */
export interface RunJob {
  readonly id: number;
  readonly run_id: number;
  readonly run_url: string;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string | null;
  readonly steps: readonly RunJobStep[];
}

export interface GithubChecksClient {
  statuses(
    owner: string,
    repo: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<readonly CommitStatus[]>;
  checkRuns(
    owner: string,
    repo: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<readonly CheckRun[]>;
  /** All Actions jobs across the workflow runs of one head commit. */
  actionJobs(
    owner: string,
    repo: string,
    headSha: string,
    signal: AbortSignal,
  ): Promise<readonly ActionJob[]>;
  /**
   * Every job of one workflow run, steps included. The endpoint pages at 30
   * items by default, which used to hide the jobs past the first page from the
   * CI-log tools; `paginate` follows the Link header so all pages arrive.
   */
  runJobs(
    owner: string,
    repo: string,
    runId: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly RunJob[]>;
  /** One job by id, steps included (`run_url`/`run_id` identify its run). */
  job(owner: string, repo: string, jobId: number, signal: AbortSignal | undefined): Promise<RunJob>;
  /** Head commit SHA of a PR — the commit whose checks are reported. */
  pullHead(owner: string, repo: string, pullNumber: number, signal: AbortSignal): Promise<string>;
  /** Resolve a SHA, branch name, or tag name to the commit's full SHA. */
  headSha(owner: string, repo: string, ref: string, signal: AbortSignal): Promise<string>;
}

/**
 * Create a client for PR CI checks, backed by a cached octokit instance.
 * Covers both check sources GitHub exposes for a commit — classic commit
 * statuses (Azure DevOps, Jenkins, ...) and check runs (GitHub Actions,
 * GitHub Apps) — so external CI is visible to the caller.
 */
const ACTIONS_RUN_URL_RE = /\/actions\/runs\/(\d+)/;
/** Job-level check runs point at `.../actions/runs/<run>/job/<job>`. */
const ACTIONS_JOB_URL_RE = /\/actions\/runs\/\d+\/job\/(\d+)/;

/** One REST job object (list and single-job endpoints share the schema). */
type ApiJob = Awaited<ReturnType<Octokit["rest"]["actions"]["getJobForWorkflowRun"]>>["data"];

function toRunJob(job: ApiJob): RunJob {
  return {
    id: job.id,
    run_id: job.run_id,
    run_url: job.run_url,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    html_url: job.html_url ?? null,
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      number: step.number,
      status: step.status,
      conclusion: step.conclusion,
      started_at: step.started_at ?? null,
    })),
  };
}

export function createGithubChecks(options: GithubClientOptions = {}): GithubChecksClient {
  const api = createGithubApi(options);

  return {
    async statuses(owner, repo, ref, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.repos.getCombinedStatusForRef({
          owner,
          repo,
          ref,
          // The statuses array is paginated and defaults to 30 per page; a
          // commit carrying more than 100 statuses is not a real scenario.
          per_page: 100,
          request: { signal },
        }),
      );
      return data.statuses.map((status) => ({
        context: status.context,
        state: status.state,
        targetUrl: status.target_url,
      }));
    },

    async checkRuns(owner, repo, ref, signal) {
      const runs = await api.call((octokit) =>
        octokit.paginate(octokit.rest.checks.listForRef, {
          owner,
          repo,
          ref,
          per_page: 100,
          request: { signal },
        }),
      );
      // The check run object itself carries no event field. Its details_url
      // contains the workflow run id, and every run of this commit (push and
      // pull_request events alike) shows up under actions/runs?head_sha=, so
      // one extra request resolves run id -> event for the suffix display.
      const runIds = new Set(
        runs
          .map((run) => ACTIONS_RUN_URL_RE.exec(run.details_url ?? "")?.[1])
          .filter((id): id is string => id !== undefined),
      );
      const events = new Map<string, string>();
      if (runIds.size > 0) {
        const commitRuns = await api.call((octokit) =>
          octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
            owner,
            repo,
            head_sha: ref,
            per_page: 100,
            request: { signal },
          }),
        );
        for (const run of commitRuns) {
          const id = String(run.id);
          if (runIds.has(id)) {
            events.set(id, run.event);
          }
        }
      }
      return runs.map((run) => {
        const detailsUrl = run.details_url ?? "";
        const runId = ACTIONS_RUN_URL_RE.exec(detailsUrl)?.[1];
        const jobId = ACTIONS_JOB_URL_RE.exec(detailsUrl)?.[1];
        return {
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          startedAt: run.started_at,
          url: run.html_url ?? run.details_url ?? null,
          event: events.get(runId ?? "") ?? null,
          runId: runId === undefined ? null : Number(runId),
          jobId: jobId === undefined ? null : Number(jobId),
        };
      });
    },

    async actionJobs(owner, repo, headSha, signal) {
      // Both levels are paginated: a commit can carry several workflow runs
      // (push and pull_request), and a single run can have more jobs than one
      // page — a missing page would silently drop failed jobs from the report.
      const runs = await api.call((octokit) =>
        octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
          owner,
          repo,
          head_sha: headSha,
          per_page: 100,
          request: { signal },
        }),
      );
      const jobs: ActionJob[] = [];
      for (const run of runs) {
        const runJobs = await api.call((octokit) =>
          octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
            owner,
            repo,
            run_id: run.id,
            per_page: 100,
            request: { signal },
          }),
        );
        for (const job of runJobs) {
          jobs.push({
            runId: run.id,
            runName: run.name ?? "",
            runUrl: run.html_url,
            jobId: job.id,
            jobName: job.name,
            conclusion: job.conclusion,
            ...(job.html_url && { jobUrl: job.html_url }),
          });
        }
      }
      return jobs;
    },

    async runJobs(owner, repo, runId, signal) {
      const jobs = await api.call((octokit) =>
        octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
          owner,
          repo,
          run_id: runId,
          per_page: 100,
          request: { signal },
        }),
      );
      return jobs.map((job) => toRunJob(job));
    },

    async job(owner, repo, jobId, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.actions.getJobForWorkflowRun({
          owner,
          repo,
          job_id: jobId,
          request: { signal },
        }),
      );
      return toRunJob(data);
    },

    async pullHead(owner, repo, pullNumber, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber, request: { signal } }),
      );
      return data.head.sha;
    },

    async headSha(owner, repo, ref, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.repos.getCommit({ owner, repo, ref, request: { signal } }),
      );
      return data.sha;
    },
  };
}
