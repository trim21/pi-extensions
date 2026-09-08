/**
 * GitHub search client built on octokit, authenticated with the token from the
 * system `gh` CLI (`gh auth token`). Used by the gh-readonly search tools.
 *
 * Unlike the `gh search` CLI, the search API has no `--state all` and treats a
 * merged PR's state as `closed` — so merged/closed disambiguation is expressed
 * through qualifiers here (`is:merged`, `state:closed -is:merged`) and the
 * rendered state is derived from `pull_request.merged_at`.
 */

import { spawn } from "node:child_process";

import { Octokit } from "octokit";

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

/** REST /search/issues response shape we consume (item is an issue/pr union). */
interface RawSearchItem {
  number: number;
  state: string;
  title: string;
  html_url: string;
  /** The search API exposes the repo as a URL, not as an object. */
  repository_url: string;
  user: { login: string } | null;
  labels: { name: string }[];
  milestone: { title: string } | null;
  assignees: { login: string }[];
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request: { merged_at: string | null } | null;
}

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
  if (repo) parts.push(`repo:${repo}`);
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
      if (kind === "issue") throw new Error("state=merged is only valid for PR searches");
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
  if (keywords) parts.push(keywords);
  if (label) parts.push(`label:${quoteQualifier(label)}`);
  if (author) parts.push(`author:${author}`);
  if (assignee) parts.push(`assignee:${assignee}`);
  if (milestone) parts.push(`milestone:${quoteQualifier(milestone)}`);
  return parts.join(" ");
}

/** Quote a qualifier value that contains whitespace or special characters. */
function quoteQualifier(value: string): string {
  if (/^[\w@./-]+$/.test(value)) return value;
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
  return iso ? iso.slice(0, 10) : "";
}

const REPO_URL_RE = /\/repos\/([^/]+\/[^/]+)$/;

/** repository_url looks like https://api.github.com/repos/OWNER/REPO */
function repoName(raw: RawSearchItem): string {
  const match = REPO_URL_RE.exec(raw.repository_url);
  return match?.[1] ?? "";
}

function normalize(raw: RawSearchItem): SearchHit {
  const mergedAt = raw.pull_request?.merged_at ?? "";
  return {
    number: raw.number,
    state: mergedAt ? "merged" : (raw.state as "open" | "closed"),
    title: raw.title,
    url: raw.html_url,
    repo: repoName(raw),
    author: raw.user?.login ?? "",
    labels: raw.labels.map((l) => l.name),
    milestone: raw.milestone?.title ?? "",
    assignees: raw.assignees.map((a) => a.login),
    comments: raw.comments,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    closedAt: toDate(raw.closed_at),
    mergedAt: toDate(mergedAt),
  };
}

function ghAuthToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGTERM"), 10_000);
    proc.stdout.on("data", (d: Buffer) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += String(d);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to start gh: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const token = stdout.trim();
      if (code === 0 && token) {
        resolve(token);
      } else {
        reject(
          new Error(
            stderr.trim() || `gh auth token exited with code ${code} — run "gh auth login" first`,
          ),
        );
      }
    });
  });
}

/**
 * Error thrown when the GitHub search API rejects the request. Carries the
 * original toolcall params so the model can see the exact input.
 */
export class GithubSearchError extends Error {
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
  if (status === 401)
    return 'GitHub auth failed (401): token invalid or expired — run "gh auth login"';
  if (status === 403) return "GitHub rate limit or permissions error (403)";
  if (status === 404) return "repository not found, or the token has no access to it (404)";
  return `GitHub API error${status === undefined ? "" : ` (HTTP ${status})`}`;
}

export interface GithubApi {
  /** Run an octokit request; retries once with a fresh token on 401. */
  call<T>(fn: (octokit: Octokit) => Promise<T>): Promise<T>;
}

/**
 * Create a shared octokit accessor. The client (and its auth token) is cached
 * in the returned closure, so repeated calls reuse the same client without
 * module-level state. A stale cached token can produce 401s; the cache is
 * dropped and the request retried once in that case.
 */
export function createGithubApi(): GithubApi {
  let client: Octokit | undefined;

  async function getClient(): Promise<Octokit> {
    client ??= new Octokit({ auth: await ghAuthToken() });
    return client;
  }

  return {
    async call(fn) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await fn(await getClient());
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 401 && attempt === 0 && client) {
            client = undefined;
            continue;
          }
          throw error;
        }
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
export function createGithubSearch(): GithubSearch {
  const api = createGithubApi();

  return {
    async search(kind, params) {
      const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);
      const effective = { ...params, limit };

      try {
        const octokit = await api.call(async (client) => {
          if (effective.assignee === "@me") {
            const { data } = await client.rest.users.getAuthenticated();
            effective.assignee = data.login;
          }
          return client;
        });
        const q = buildSearchQuery(kind, effective);
        const { data } = await octokit.rest.search.issuesAndPullRequests({
          q,
          per_page: limit,
        });
        return data.items.map((item) => normalize(item as unknown as RawSearchItem));
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
}

/**
 * Create a client for PR CI checks, backed by a cached octokit instance.
 * Covers both check sources GitHub exposes for a commit — classic commit
 * statuses (Azure DevOps, Jenkins, ...) and check runs (GitHub Actions,
 * GitHub Apps) — so external CI is visible to the caller.
 */
const ACTIONS_RUN_URL_RE = /\/actions\/runs\/(\d+)/;
export function createGithubChecks(): GithubChecksClient {
  const api = createGithubApi();

  return {
    async statuses(owner, repo, ref, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref, request: { signal } }),
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
        const { data } = await api.call((octokit) =>
          octokit.rest.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            head_sha: ref,
            per_page: 100,
            request: { signal },
          }),
        );
        for (const run of data.workflow_runs) {
          const id = String(run.id);
          if (runIds.has(id)) events.set(id, run.event);
        }
      }
      return runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        startedAt: run.started_at,
        url: run.html_url ?? run.details_url ?? null,
        event: events.get(ACTIONS_RUN_URL_RE.exec(run.details_url ?? "")?.[1] ?? "") ?? null,
      }));
    },

    async actionJobs(owner, repo, headSha, signal) {
      const { data } = await api.call((octokit) =>
        octokit.rest.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          head_sha: headSha,
          per_page: 100,
          request: { signal },
        }),
      );
      const jobs: ActionJob[] = [];
      for (const run of data.workflow_runs) {
        const { data: jobsData } = await api.call((octokit) =>
          octokit.rest.actions.listJobsForWorkflowRun({
            owner,
            repo,
            run_id: run.id,
            per_page: 100,
            request: { signal },
          }),
        );
        for (const job of jobsData.jobs) {
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
  };
}
