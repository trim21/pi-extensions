/**
 * Shared infrastructure of the GitHub read-only tools: result shaping, the
 * octokit-backed client, and the checks-wait pipeline (running a `gh` process
 * itself lives in `lib/gh-process.ts`, which also owns the proxy env shared by
 * the subprocess and octokit). Each tool lives in `tools/<tool-name>.ts`;
 * anything used by more than one tool belongs here.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { egress } from "../lib/egress.js";
import { type GhResult, runGh } from "../lib/gh-process.js";
import {
  type ActionJob,
  type CheckRun,
  type CheckSuite,
  type CommitStatus,
  createGithubApi,
  createGithubChecks,
  createGithubSearch,
  type GithubChecksClient,
  type GithubClientOptions,
  type GithubSearch,
  normalizeRestList,
  type SearchHit,
  type WorkflowRunRef,
} from "../lib/github.js";
import { createGithubReads, type GithubReads } from "../lib/github-reads.js";
import { parseWithSchema } from "../lib/parse-with-schema.js";
import { type StructuredResult } from "../lib/tool-bus.js";
import { checksVerdictSchema, ghRunSummarySchema } from "./schemas.js";

/** 结构化失败（Result 的失败支）：与具体的输出类型无关，任何脚本工具都能用。 */
export interface StructuredFailure {
  ok: false;
  error: string;
}

/** What a toolcall handler receives from the framework. */
export interface ToolCall<Params> {
  params: Params;
  ctx: { cwd?: string };
  signal?: AbortSignal;
}

/**
 * Check whether the `gh` CLI is on the system, scanning PATH like
 * `findDefaultBwrap`. The extension registers no tools when `gh` is missing, so
 * the model never sees GitHub tools that would fail on every call.
 */
export function isGhAvailable(): boolean {
  const pathEnv = process.env.PATH ?? "";
  for (const directory of pathEnv.split(delimiter)) {
    if (existsSync(join(directory, "gh"))) {
      return true;
    }
  }
  for (const candidate of ["/usr/bin/gh", "/usr/local/bin/gh", "/run/current-system/sw/bin/gh"]) {
    if (existsSync(candidate)) {
      return true;
    }
  }
  return false;
}

/**
 * Error thrown by `ghExec` when the `gh` invocation exits non-zero.
 * The message carries the toolcall input (JSON) wrapped in `<input>` markers,
 * and the command output wrapped in `<output>` markers.
 */
export class GhError extends Error {
  readonly args: string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly input?: unknown;

  constructor(args: string[], result: GhResult, input?: unknown) {
    const inputText = input === undefined ? "" : `<input>${JSON.stringify(input)}<input>\n`;
    const killedText = result.killed
      ? result.reason === "timeout"
        ? " (command timed out)"
        : result.reason === "abort"
          ? " (command aborted)"
          : ""
      : "";

    // The process never started (e.g. `gh` not found): surface the spawn error.
    // Otherwise show the command's own output; an empty output with a non-zero
    // exit is explicitly marked, so a bare "exit code 1" can't be mistaken for
    // a specific failure.
    let outputText: string;
    if (result.spawnError) {
      outputText = `spawn failed: ${result.spawnError}`;
    } else if (result.combined.trim()) {
      outputText = result.combined.trim();
    } else {
      outputText = `exit code ${result.code} (no output)`;
    }

    super(`${inputText}<output>${outputText}${killedText}<output>`);
    this.name = "GhError";
    this.args = args;
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.input = input;
  }
}

/** Run `gh` and return stdout. On non-zero exit, throws a `GhError` carrying the toolcall input and raw command. */
export async function ghExec(
  args: string[],
  ctx: { cwd?: string; signal?: AbortSignal; input?: unknown; timeout?: number },
): Promise<string> {
  const result = await runGh(args, ctx);
  if (result.code !== 0) {
    throw new GhError(args, result, ctx.input);
  }
  return result.stdout;
}

/** Split `OWNER/REPO`; throws when the name doesn't have exactly one slash. */
export function splitRepo(nameWithOwner: string): { owner: string; repo: string } {
  const slash = nameWithOwner.indexOf("/");
  if (slash <= 0 || slash === nameWithOwner.length - 1 || nameWithOwner.includes("/", slash + 1)) {
    throw new Error(`invalid repository: ${nameWithOwner} (expected OWNER/REPO)`);
  }
  return { owner: nameWithOwner.slice(0, slash), repo: nameWithOwner.slice(slash + 1) };
}

/** Parse a positive integer toolcall parameter (run/job ids are numbers or numeric strings). */
export function toPositiveId(value: number | string, name: string): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`invalid ${name}: ${String(value)} (expected a positive integer)`);
  }
  return id;
}

const repoViewSchema = Type.Object({ nameWithOwner: Type.String() });

/** Resolve the repo a toolcall should act on: the parameter, or `gh repo view`. */
export async function resolveRepo(
  repo: string | undefined,
  signal: AbortSignal | undefined,
  cwd: string | undefined,
  input?: unknown,
): Promise<string> {
  if (repo) {
    return repo;
  }
  const stdout = await ghExec(["repo", "view", "--json", "nameWithOwner"], { cwd, signal, input });
  const { nameWithOwner } = Value.Parse(repoViewSchema, JSON.parse(stdout));
  return nameWithOwner;
}

/** 工具操作的仓库：`OWNER/REPO` 全名加拆分后的两段。 */
export interface RepoTarget {
  /** 规范化的 `OWNER/REPO`（参数缺省时来自当前目录解析）。 */
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
}

/**
 * 解析工具该操作的仓库并拆开 `OWNER/REPO`。取数工具都要走这一步，收成一个调用
 * 后每个工具只剩一行，也不再需要各自 import `splitRepo`。
 */
export async function resolveRepoTarget(
  repo: string | undefined,
  signal: AbortSignal | undefined,
  cwd: string | undefined,
  input?: unknown,
): Promise<RepoTarget> {
  const fullName = await resolveRepo(repo, signal, cwd, input);
  const { owner, repo: name } = splitRepo(fullName);
  return { fullName, owner, name };
}

/** 成功结果：把外部数据按该工具的 `structuredSchema` 校验后交给脚本。 */
export function structuredResult<T extends TSchema>(
  schema: T,
  data: unknown,
): StructuredResult<Static<T>> {
  return { ok: true, value: parseWithSchema(schema, data) };
}

/** 结构化失败（Result 的失败支）：不必抛异常就能把「没找到」这类结果告诉脚本。 */
export function structuredFailure(error: string): StructuredFailure {
  return { ok: false, error };
}

/**
 * `list-github-issues` / `list-github-prs` 共用的一套过滤参数，只有 `state` 的说明文案按
 * kind 不同。
 */
export function listFilterParameters(kind: "issue" | "pr") {
  const isPr = kind === "pr";
  return Type.Object({
    repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
    keywords: Type.Optional(Type.String({ description: "Search keywords (free text)" })),
    state: Type.Optional(
      Type.String({
        description: isPr
          ? "open, closed, merged, all (default: open; all applies to keyword search and covers open + closed + merged)"
          : "open, closed, all (default: open; all applies to keyword search and covers closed too)",
      }),
    ),
    label: Type.Optional(Type.String({ description: "Filter by label" })),
    // `@me` 只在关键词搜索分支可用：搜索 API 自己把它解析成当前登录用户。浏览分支走
    // REST 列表端点，`@me` 按字面量转发，不会匹配到当前用户（本仓库不做展开）。
    author: Type.Optional(
      Type.String({
        description: "Filter by author ('@me' works with keywords; browse takes it literally)",
      }),
    ),
    assignee: Type.Optional(
      Type.String({
        description: "Filter by assignee ('@me' works with keywords; browse takes it literally)",
      }),
    ),
    milestone: Type.Optional(Type.String({ description: "Filter by milestone" })),
    limit: Type.Optional(Type.Number({ description: "Max results (default 30, max 100)" })),
  });
}

export interface ListFilters {
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
 * 浏览分支（不带 keywords）：走 octokit 的 REST 列表端点，再归一到与搜索分支同一套
 * `SearchHit`。repo 缺省时先解析当前仓库（每个命中项都带它归一化后的 `repo`）。
 */
export async function browseList(
  gh: GhClient,
  kind: "issue" | "pr",
  params: ListFilters,
  ctx: { cwd?: string; signal?: AbortSignal; input?: unknown },
): Promise<SearchHit[]> {
  const {
    fullName: repo,
    owner,
    name,
  } = await resolveRepoTarget(params.repo, ctx.signal, ctx.cwd, ctx.input);
  const query = {
    state: params.state,
    label: params.label,
    author: params.author,
    assignee: params.assignee,
    milestone: params.milestone,
    limit: params.limit,
  };
  const items =
    kind === "issue"
      ? await gh.reads.listIssues(owner, name, query, ctx.signal)
      : await gh.reads.listPulls(owner, name, query, ctx.signal);
  return normalizeRestList(items, repo);
}

/**
 * The GitHub reads that go through the REST API, with the HTTP layer injected:
 * production hands in the proxy-aware fetch, tests hand in a stub and never
 * touch the network. The per-tool handlers live next to their tool
 * registration in `tools/` and take the client as their state.
 *
 * `fetch` is a property (not module state) so a caller that needs different HTTP
 * behavior — a test, another host — constructs its own instance.
 */
export class GhClient {
  readonly fetch: typeof globalThis.fetch;
  readonly search: GithubSearch;
  readonly checks: GithubChecksClient;
  /** REST 读取层：gh 工具的取数都走它（不再 spawn `gh` 取数据）。 */
  readonly reads: GithubReads;

  constructor(
    fetchImpl: typeof globalThis.fetch = egress.fetch,
    options: Pick<GithubClientOptions, "token"> = {},
  ) {
    this.fetch = fetchImpl;
    // 三个子客户端共用同一个 accessor，因此也共用同一份 octokit 与 token 缓存
    // （各自 createGithubApi 会让一个会话最多 spawn 三次 `gh auth token`）。
    const api = createGithubApi({ fetch: fetchImpl, ...options });
    this.search = createGithubSearch(api);
    this.checks = createGithubChecks(api);
    this.reads = createGithubReads(api);
  }
}

// ── checks watch (pure rendering + poll loop) ────────────────────────────────

const CHECKS_POLL_INTERVAL_MS = 30_000;
/** `watch-github-run` 的轮询间隔与上限。 */
const RUN_WATCH_INTERVAL_MS = 30_000;
const RUN_WATCH_DEADLINE_MS = 600_000;

const CHECKS_WATCH_DEADLINE_MS = 600_000;

export type CheckBucket = "pass" | "skipped" | "fail" | "pending" | "action_required";

/**
 * One judged CI check of a commit: a single commit status, check run, or a
 * check suite that has no check runs of its own (a workflow waiting for human
 * approval). Same-named entries from different sources (push vs pull_request
 * events, status vs check run channels) stay separate, like the GitHub checks
 * UI.
 */
export interface MergedCheck {
  readonly name: string;
  readonly bucket: CheckBucket;
  readonly startedAt: string | null;
  readonly link: string | null;
  /** Triggering workflow event (push, pull_request, ...); null when unknown. */
  readonly event: string | null;
  /** Owning check suite; null for commit statuses. */
  readonly suiteId: number | null;
  /** Actions run id behind this check, for `get-github-workflow-jobs`; null when unknown. */
  readonly runId: number | null;
  /** Actions job id behind this check, for `read-github-ci-logs`; null when unknown. */
  readonly jobId: number | null;
}

function statusBucket(state: string): CheckBucket {
  if (state === "success") {
    return "pass";
  }
  if (state === "failure" || state === "error") {
    return "fail";
  }
  // pending, expected, and anything unknown must not end the wait
  return "pending";
}

function checkRunBucket(run: CheckRun): CheckBucket {
  return conclusionBucket(run.status, run.conclusion);
}

function suiteBucket(suite: CheckSuite): CheckBucket {
  return conclusionBucket(suite.status, suite.conclusion);
}

function conclusionBucket(status: string | null, conclusion: string | null): CheckBucket {
  if (status !== "completed" || conclusion === null) {
    return "pending";
  }
  switch (conclusion) {
    case "success": {
      return "pass";
    }
    case "action_required": {
      // No job was ever created (fork-PR approval) or a human has to act: it
      // cannot start on its own, so it must never be judged as passed.
      return "action_required";
    }
    case "skipped":
    case "neutral":
    case "stale": {
      return "skipped";
    }
    case "failure":
    case "timed_out":
    case "cancelled":
    case "startup_failure": {
      return "fail";
    }
    default: {
      return "pending";
    }
  }
}

/**
 * Judge the commit's statuses, check runs and suites into one flat list of
 * checks, keeping same-named entries distinct so the wait verdict (any fail /
 * all pass-or-skipped across every entry) can never lose a failure.
 *
 * A suite becomes its own entry only when it is finished AND carries no check
 * run — otherwise it is either already represented by its check runs (a suite
 * conclusion is just their rollup, counting both would double-count CI) or an
 * empty per-app shell that never reports anything. Finished suites with no
 * check runs are where a workflow waiting for approval lives: GitHub creates
 * the suite and the workflow run but never a check run. Pure — no network.
 */
export function mergeChecks(
  statuses: readonly CommitStatus[],
  checkRuns: readonly CheckRun[],
  suites: readonly CheckSuite[],
  workflowRuns: readonly WorkflowRunRef[],
): MergedCheck[] {
  const runsById = new Map(workflowRuns.map((run) => [run.id, run] as const));
  const runsBySuite = new Map(
    workflowRuns
      .filter((run) => run.checkSuiteId !== null)
      .map((run) => [run.checkSuiteId, run] as const),
  );

  const checks: MergedCheck[] = [
    ...statuses.map((status) => ({
      name: status.context,
      bucket: statusBucket(status.state),
      startedAt: null,
      link: status.targetUrl,
      event: null,
      suiteId: null,
      runId: null,
      jobId: null,
    })),
    ...checkRuns.map((run) => ({
      name: run.name,
      bucket: checkRunBucket(run),
      startedAt: run.startedAt,
      link: run.url,
      event: run.runId === null ? null : (runsById.get(run.runId)?.event ?? null),
      suiteId: run.checkSuiteId,
      runId: run.runId,
      jobId: run.jobId,
    })),
  ];

  const representedSuites = new Set(
    checkRuns.map((run) => run.checkSuiteId).filter((id): id is number => id !== null),
  );
  for (const suite of suites) {
    // A suite that is not finished yet and has no check runs is a shell: GitHub
    // creates one per app per commit, and most apps (netlify, vercel, renovate,
    // ...) never put anything in it — listing those as pending checks would hang
    // every wait forever.
    if (
      representedSuites.has(suite.id) ||
      suite.status !== "completed" ||
      suite.conclusion === null
    ) {
      continue;
    }
    const run = runsBySuite.get(suite.id);
    checks.push({
      name: run?.name || suite.appSlug,
      bucket: suiteBucket(suite),
      startedAt: run?.runStartedAt ?? null,
      link: run?.htmlUrl ?? null,
      event: run?.event ?? null,
      suiteId: suite.id,
      runId: run?.id ?? null,
      jobId: null,
    });
  }

  return checks;
}

function sleepInterruptibly(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted while waiting for the next checks poll"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type ChecksPollOutcome = "completed" | "fail_fast" | "awaiting_approval" | "timeout";

export interface ChecksPollResult {
  readonly outcome: ChecksPollOutcome;
  readonly checks: readonly MergedCheck[];
  readonly elapsedMs: number;
}

export interface PollPrChecksOptions {
  owner: string;
  repo: string;
  headSha: string;
  failFast: boolean;
  checks: GithubChecksClient;
  /**
   * When set, only check runs triggered by this workflow event (e.g. push)
   * are judged; commit statuses have an unknown trigger event and are
   * excluded. Unset means all checks of the commit.
   */
  event?: string;
  /** Owned by the caller; the poll loop observes it but never aborts it. */
  signal: AbortSignal;
  /** Test overrides. */
  intervalMs?: number;
  deadlineMs?: number;
}

/**
 * Poll the commit's combined-status and check-runs APIs until the wait
 * semantics are met: return on any failure (immediately under fail-fast) or
 * when every check is complete (pass/skipped).
 *
 * A failed round (network, auth) does not end the wait — the error is kept
 * and polling continues, so a transient blip or a CI system that has not
 * reported anything yet cannot be mistaken for a completed check set. Only
 * when no round ever succeeded by the deadline is the last error thrown.
 */
export async function pollPrChecks(options: PollPrChecksOptions): Promise<ChecksPollResult> {
  const { owner, repo, headSha, failFast, checks, signal } = options;
  const intervalMs = options.intervalMs ?? CHECKS_POLL_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? CHECKS_WATCH_DEADLINE_MS;

  const watchStart = Date.now();
  let lastChecks: readonly MergedCheck[] = [];
  let lastError: unknown;
  let everSucceeded = false;

  for (;;) {
    if (signal.aborted) {
      throw new Error("PR checks polling was aborted");
    }
    try {
      const [statuses, runs, suites] = await Promise.all([
        checks.statuses(owner, repo, headSha, signal),
        checks.checkRuns(owner, repo, headSha, signal),
        checks.suites(owner, repo, headSha, signal),
      ]);
      // Suites and check runs both get their event/name from the commit's
      // workflow runs, so the list is fetched once and shared.
      const needsRuns = suites.length > 0 || runs.some((run) => run.runId !== null);
      const commitRuns = needsRuns ? await checks.workflowRuns(owner, repo, headSha, signal) : [];
      everSucceeded = true;
      lastChecks = mergeChecks(statuses, runs, suites, commitRuns);
      if (options.event) {
        lastChecks = lastChecks.filter((c) => c.event === options.event);
      }
      // A failure is the actionable verdict, so `fail_fast` still wins here.
      if (failFast && lastChecks.some((c) => c.bucket === "fail")) {
        return { outcome: "fail_fast", checks: lastChecks, elapsedMs: Date.now() - watchStart };
      }
      // A check waiting for human approval cannot start on its own: polling
      // further rounds would only burn the deadline.
      if (lastChecks.some((c) => c.bucket === "action_required")) {
        return {
          outcome: "awaiting_approval",
          checks: lastChecks,
          elapsedMs: Date.now() - watchStart,
        };
      }
      if (lastChecks.every((c) => c.bucket !== "pending")) {
        return { outcome: "completed", checks: lastChecks, elapsedMs: Date.now() - watchStart };
      }
    } catch (error) {
      // 不用 if (signal.aborted)：循环顶部的同名字段检查把它收窄成 false，
      // TS 会在 catch 里维持这个收窄。
      signal.throwIfAborted();
      lastError = error;
    }
    if (Date.now() - watchStart >= deadlineMs) {
      if (!everSucceeded) {
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`PR checks polling failed before any round succeeded: ${message}`);
      }
      return { outcome: "timeout", checks: lastChecks, elapsedMs: Date.now() - watchStart };
    }
    await sleepInterruptibly(intervalMs, signal);
  }
}

/** One polled workflow run: the REST fields the watch loop reports and renders. */
export interface RunSnapshot {
  id: number;
  name?: string | null;
  display_title?: string;
  status?: string | null;
  conclusion?: string | null;
  head_branch?: string | null;
  event?: string;
  created_at?: string;
  updated_at?: string;
  run_started_at?: string;
  html_url?: string;
}

export interface WatchRunOptions {
  owner: string;
  repo: string;
  runId: number;
  reads: GithubReads;
  /** Owned by the caller; the poll loop observes it but never aborts it. */
  signal: AbortSignal;
  /** Test overrides. */
  intervalMs?: number;
  deadlineMs?: number;
}

export interface RunWatchResult {
  outcome: "completed" | "timeout";
  run: RunSnapshot;
  elapsedMs: number;
}

/**
 * 轮询 `getWorkflowRun` 直到运行结束（`gh run watch` 的替代）：固定间隔轮询，超过上限以
 * timeout 结束（不挂住）。不输出进度——这条路径上没有会消费它的调用方。
 */
export async function watchRun(options: WatchRunOptions): Promise<RunWatchResult> {
  const { owner, repo, runId, reads, signal } = options;
  const intervalMs = options.intervalMs ?? RUN_WATCH_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? RUN_WATCH_DEADLINE_MS;

  const watchStart = Date.now();
  for (;;) {
    signal.throwIfAborted();
    const run = parseWithSchema(ghRunSummarySchema, await reads.run(owner, repo, runId, signal));
    const elapsedMs = Date.now() - watchStart;
    if (run.status === "completed") {
      return { outcome: "completed", run, elapsedMs };
    }
    if (elapsedMs >= deadlineMs) {
      return { outcome: "timeout", run, elapsedMs };
    }
    await sleepInterruptibly(intervalMs, signal);
  }
}

/** Job conclusions that count as "did not succeed" for CI result reporting. */
const FAILED_JOB_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
  "cancelled",
]);

/** One Actions job that did not succeed, for the FAILED verdict details. */
export interface FailedActionJob {
  readonly runId: number;
  readonly runName: string;
  readonly runUrl: string;
  readonly jobId: number;
  readonly jobName: string;
  readonly conclusion: string;
  readonly jobUrl?: string;
}

export interface ChecksVerdict {
  readonly status: "success" | "failure" | "pending" | "awaiting_approval";
  readonly failedJobs: readonly FailedActionJob[];
}

/**
 * Turn a poll result into the final verdict: the status comes from the checks
 * buckets alone (so external CI such as Azure counts); Actions jobs are
 * payload-only enrichment. Pure — no network.
 */
export function checksVerdict(options: {
  poll: ChecksPollResult;
  /** All Actions jobs of the head commit; the ones that did not succeed enter `failedJobs`. */
  actionJobs?: readonly ActionJob[];
}): ChecksVerdict {
  const { poll, actionJobs } = options;
  const failed = poll.checks.filter((c) => c.bucket === "fail");

  if (failed.length === 0 && poll.outcome === "completed") {
    return { status: "success", failedJobs: [] };
  }

  if (failed.length > 0) {
    const failedJobs: FailedActionJob[] = (actionJobs ?? [])
      .filter((j) => !j.conclusion || FAILED_JOB_CONCLUSIONS.has(j.conclusion))
      .map((j) => ({
        runId: j.runId,
        runName: j.runName,
        runUrl: j.runUrl,
        jobId: j.jobId,
        jobName: j.jobName,
        conclusion: j.conclusion ?? "in_progress",
        ...(j.jobUrl && { jobUrl: j.jobUrl }),
      }));
    return { status: "failure", failedJobs };
  }

  if (poll.outcome === "awaiting_approval") {
    return { status: "awaiting_approval", failedJobs: [] };
  }

  return { status: "pending", failedJobs: [] };
}

/**
 * Shared wait core of `wait-github-pr-checks` and `wait-github-commit-checks`:
 * poll the commit's checks, enrich the FAILED verdict with Actions job details,
 * and return the structured verdict. The caller resolves repo/headSha.
 */
export async function waitChecksReport(options: {
  checks: GithubChecksClient;
  owner: string;
  repo: string;
  headSha: string;
  failFast: boolean;
  event?: string;
  signal: AbortSignal | undefined;
}): Promise<StructuredResult<Static<typeof checksVerdictSchema>>> {
  const { owner, repo, headSha, failFast, event, signal } = options;

  // 轮询层要求非空 signal；框架可能不给时构造一个占位的（从不取消）。
  const pollSignal = signal ?? new AbortController().signal;

  const poll = await pollPrChecks({
    owner,
    repo,
    headSha,
    failFast,
    event,
    checks: options.checks,
    signal: pollSignal,
  });

  // Actions job 详情只补充失败 job 明细，不影响判定（判定来自 checks bucket，
  // 覆盖 Azure 等外部 CI）。抓取失败只让 failedJobs 为空，不推翻结论。
  let actionJobs: readonly ActionJob[] | undefined;
  if (poll.checks.some((c) => c.bucket === "fail")) {
    try {
      actionJobs = await options.checks.actionJobs(owner, repo, headSha, pollSignal);
    } catch {
      // 补充数据可有可无：保留 actionJobs 为 undefined
    }
  }

  const verdict = checksVerdict({ poll, actionJobs });
  return structuredResult(checksVerdictSchema, {
    status: verdict.status,
    totalChecks: poll.checks.length,
    // 复制成可变数组：结构化结果的类型要与 structuredSchema 的静态类型一致
    checks: [...poll.checks],
    failedJobs: [...verdict.failedJobs],
  });
}
