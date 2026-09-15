/**
 * Shared infrastructure of the GitHub read-only tools: the `gh` subprocess
 * layer, result shaping, the octokit-backed client, and the checks-wait
 * pipeline. Each tool lives in `tools/<tool-name>.ts`; anything used by more
 * than one tool belongs here.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  type ActionJob,
  type CheckRun,
  type CommitStatus,
  createGithubChecks,
  createGithubSearch,
  type GithubChecksClient,
  type GithubSearch,
  renderHits,
} from "../lib/github.js";
import { type ToolPendant } from "../lib/pendant.js";
import { createHttpProxy } from "../lib/proxy.js";

/**
 * 代理配置（~/.pi/agent/proxy.json，回退到 HTTP(S)_PROXY 环境变量）在本模块内共享：
 * `gh` 子进程与 octokit 请求都从这里取，配置只在首次使用时读一次。
 */
export const httpProxy = createHttpProxy();

/** A tool result: what the model sees plus the structured details payload. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

/** What a toolcall handler receives from the framework. */
export interface ToolCall<Params> {
  params: Params;
  ctx: { cwd?: string };
  signal?: AbortSignal;
  /** Streaming progress updates, passed through as-is. */
  onUpdate?: (update: ToolResult) => void;
}

export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  combined: string;
  /** Why the process was killed, when `killed` is true. */
  reason?: "timeout" | "abort";
  /** When the process could not be started at all (e.g. `gh` not found in PATH). */
  spawnError?: string;
}

/**
 * Check whether the `gh` CLI is on the system, scanning PATH like
 * `findDefaultBwrap`. The extension registers no tools when `gh` is missing, so
 * the model never sees GitHub tools that would fail on every call.
 */
export function isGhAvailable(): boolean {
  const pathEnv = process.env.PATH ?? "";
  for (const directory of pathEnv.split(delimiter)) {
    if (existsSync(join(directory, "gh"))) return true;
  }
  for (const candidate of ["/usr/bin/gh", "/usr/local/bin/gh", "/run/current-system/sw/bin/gh"]) {
    if (existsSync(candidate)) return true;
  }
  return false;
}

export function runGh(
  args: string[],
  ctx: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
    /** 追加到子进程环境变量（覆盖进程环境与代理配置），供测试或调用方定制。 */
    env?: NodeJS.ProcessEnv;
  },
): Promise<GhResult> {
  return new Promise((resolve) => {
    const proc = spawn("gh", args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // gh 是 Go 程序，只认环境变量形式的代理配置；ctx.env 最后合并，调用方可覆盖。
      env: { ...process.env, ...httpProxy.env, ...ctx.env, GH_PAGER: "cat" },
    });

    let stdout = "";
    let stderr = "";
    const combined: string[] = [];
    let killed = false;
    let killReason: "timeout" | "abort" | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const killProcess = (reason: "timeout" | "abort") => {
      if (killed) {
        return;
      }

      killed = true;
      killReason = reason;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    };

    if (ctx.signal) {
      onAbort = () => killProcess("abort");
      if (ctx.signal.aborted) {
        killProcess("abort");
      } else {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Default timeout: 10 minutes. Long operations like downloading a CI job's
    // full log routinely take well over 30s, so a short default would kill them
    // mid-transfer; combined with `code ?? 0` that would silently cache a
    // truncated log as success. A killed process must never look successful.
    const timeout = ctx.timeout ?? 600_000;
    if (timeout > 0) {
      timeoutId = setTimeout(() => killProcess("timeout"), timeout);
    }

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      combined.push(text);
    });
    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      combined.push(text);
    });

    proc.on("close", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (onAbort && ctx.signal) {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      resolve({
        stdout,
        stderr,
        // When killed by a signal the close event's code is null; report the
        // process as failed instead of pretending it succeeded. -1 is a
        // sentinel for "did not exit normally" — distinct from a real gh
        // failure exit code (1), which is always in 0-255.
        code: code ?? (killed ? -1 : 0),
        killed,
        combined: combined.join(""),
        reason: killReason,
      });
    });

    proc.on("error", (err: Error) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (onAbort && ctx.signal) {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      // spawn 失败（如 gh 不在 PATH → ENOENT、cwd 不存在）时进程从未启动，
      // 没有任何 stdout/stderr；把底层错误带上，否则会退化成无信息的 "exit code 1"。
      resolve({
        stdout,
        stderr,
        code: 1,
        killed,
        combined: combined.join(""),
        reason: killReason,
        spawnError: err.message,
      });
    });
  });
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

export function repoArgs(repo?: string): string[] {
  return repo ? ["--repo", repo] : [];
}

/**
 * `gh api` for a JSON-array endpoint, following pagination. The REST API pages
 * these lists at 30 items by default, so a single page silently drops the rest;
 * `--slurp` is required because `--paginate` alone prints the pages back to back
 * (not valid JSON), and the page arrays are flattened back into one list.
 */
export async function ghApiList(
  path: string,
  ctx: { cwd?: string; signal?: AbortSignal; input?: unknown },
): Promise<unknown[]> {
  const out = await ghExec(["api", "--paginate", "--slurp", path], ctx);
  return Value.Parse(Type.Array(Type.Array(Type.Unknown())), JSON.parse(out)).flat();
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
  if (repo) return repo;
  const stdout = await ghExec(["repo", "view", "--json", "nameWithOwner"], { cwd, signal, input });
  const { nameWithOwner } = Value.Parse(repoViewSchema, JSON.parse(stdout));
  return nameWithOwner;
}

export function truncate(
  text: string,
  maxLines = 2000,
  maxBytes = 50 * 1024,
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }

  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (out.length >= maxLines) break;
    const lineBytes = Buffer.byteLength(line + "\n", "utf8");
    if (bytes + lineBytes > maxBytes) break;
    out.push(line);
    bytes += lineBytes;
  }
  return { text: out.join("\n"), truncated: true };
}

/**
 * Format a successful gh invocation's stdout into a tool result.
 * Failures are thrown by `ghExec` as `GhError`, so only the success path lives here.
 */
export function toToolResult(
  stdout: string,
  input?: unknown,
): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  const { text, truncated } = truncate(stdout);
  return {
    content: [{ type: "text", text }],
    details: { ...(input !== undefined && { input }), truncated },
  };
}

/**
 * Pendant subtitle for a tool result: `repo=x/y` (when provided) plus the
 * tool's id parameter, e.g. `repo=x/y number=123`. Returns undefined when
 * neither is available, so the pendant is omitted rather than shown empty.
 */
export function subtitlePendant<IdKey extends string = never>(
  params: { repo?: string } & Partial<Record<IdKey, string | number>>,
  idKey?: IdKey,
): ToolPendant | undefined {
  const parts: string[] = [];
  if (params.repo) parts.push(`repo=${params.repo}`);
  const id = idKey === undefined ? undefined : params[idKey];
  if (typeof id === "string" || typeof id === "number") parts.push(`${idKey}=${id}`);
  if (parts.length === 0) return undefined;
  return { subtitle: parts.join(" ") };
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
  /** Comma-separated field names for the keyword-search result rows. */
  fields?: string;
}

/**
 * Build the `gh` argv for browsing issues/PRs (no keyword search).
 *
 * Keyword searches no longer go through the `gh` CLI — the octokit-based client
 * in `../lib/github.ts` handles them with state values (`all`, and `merged` for
 * PRs) that `gh search` cannot express. Browse calls keep `gh issue list` /
 * `gh pr list` semantics: `state` is passed through verbatim, since `gh issue
 * list` accepts open/closed/all and `gh pr list` additionally accepts merged.
 */
export function listGithubArgs(kind: "issue" | "pr", params: ListFilters): string[] {
  const { repo, state, label, author, assignee, milestone, limit } = params;

  const args = [kind, "list", ...repoArgs(repo)];
  if (state) args.push("--state", state);
  if (label) args.push("--label", label);
  if (author) args.push("--author", author);
  if (assignee) args.push("--assignee", assignee);
  if (milestone) args.push("--milestone", milestone);
  if (limit) args.push("--limit", String(limit));
  return args;
}

export async function listGithub(
  kind: "issue" | "pr",
  params: ListFilters,
  ctx: { cwd?: string; signal?: AbortSignal; input?: unknown },
): Promise<string> {
  return ghExec(listGithubArgs(kind, params), ctx);
}

/** Run a keyword search through the octokit client and render the rows. */
export async function searchList(
  kind: "issue" | "pr",
  params: ListFilters,
  githubSearch: GithubSearch,
): Promise<string> {
  const hits = await githubSearch.search(kind, params);
  if (hits.length === 0) {
    return `(no matching ${kind === "issue" ? "issues" : "pull requests"})`;
  }
  return renderHits(hits, { repo: params.repo, fields: params.fields });
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

  constructor(fetchImpl: typeof globalThis.fetch = httpProxy.fetch) {
    this.fetch = fetchImpl;
    this.search = createGithubSearch({ fetch: fetchImpl });
    this.checks = createGithubChecks({ fetch: fetchImpl });
  }
}

// ── checks watch (pure rendering + poll loop) ────────────────────────────────

const CHECKS_POLL_INTERVAL_MS = 30_000;
const CHECKS_WATCH_DEADLINE_MS = 600_000;

export type CheckBucket = "pass" | "skipped" | "fail" | "pending";

/**
 * One judged CI check of a commit: a single commit status or check run, kept
 * distinct — same-named checks from different sources (push vs pull_request
 * events, status vs check run channels) stay separate entries, like the
 * GitHub checks UI.
 */
export interface MergedCheck {
  readonly name: string;
  readonly bucket: CheckBucket;
  readonly startedAt: string | null;
  readonly link: string | null;
  /** Triggering workflow event (push, pull_request, ...); null when unknown. */
  readonly event: string | null;
  /** Actions run id behind this check, for `get-github-workflow-jobs`; null when unknown. */
  readonly runId: number | null;
  /** Actions job id behind this check, for `read-github-ci-logs`; null when unknown. */
  readonly jobId: number | null;
}

function statusBucket(state: string): CheckBucket {
  if (state === "success") return "pass";
  if (state === "failure" || state === "error") return "fail";
  // pending, expected, and anything unknown must not end the wait
  return "pending";
}

function checkRunBucket(run: CheckRun): CheckBucket {
  if (run.status !== "completed" || run.conclusion === null) return "pending";
  switch (run.conclusion) {
    case "success": {
      return "pass";
    }
    case "skipped":
    case "neutral":
    case "stale":
    case "action_required": {
      // awaiting maintainer approval: it will never run, so waiting for it is
      // meaningless — treat like skipped
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
 * Judge the commit's statuses and check runs into individual checks, keeping
 * same-named entries distinct so the wait verdict (any fail / all
 * pass-or-skipped across every entry) can never lose a failure. Pure — no
 * network.
 */
export function mergeChecks(
  statuses: readonly CommitStatus[],
  checkRuns: readonly CheckRun[],
): MergedCheck[] {
  return [
    ...statuses.map((status) => ({
      name: status.context,
      bucket: statusBucket(status.state),
      startedAt: null,
      link: status.targetUrl,
      event: null,
      runId: null,
      jobId: null,
    })),
    ...checkRuns.map((run) => ({
      name: run.name,
      bucket: checkRunBucket(run),
      startedAt: run.startedAt,
      link: run.url,
      event: run.event,
      runId: run.runId,
      jobId: run.jobId,
    })),
  ];
}

/** Display name of a check; the trigger event is labelled like the GitHub UI (`build (pull_request)`). */
export function checkDisplayName(check: MergedCheck): string {
  return check.event ? `${check.name} (${check.event})` : check.name;
}

/**
 * Render one polling round as a compact bullet list of the checks still in
 * flight: running ones first (`- [>]`), queued ones after (`- [ ]`). Completed
 * checks are hidden — the header already reports the completion count.
 * Pure — no network.
 */
export function renderPrChecksList(options: {
  /** Report subject, e.g. `PR #7` or `commit 5a7c407`. */
  subject: string;
  round: number;
  checks: readonly MergedCheck[];
}): string {
  const { subject, round, checks } = options;
  const completed = checks.filter((c) => c.bucket !== "pending").length;

  const pending = checks.filter((c) => c.bucket === "pending");
  const ordered = [...pending.filter((c) => c.startedAt), ...pending.filter((c) => !c.startedAt)];
  const lines = ordered.map((check) => {
    const name = check.link
      ? `[${checkDisplayName(check)}](${check.link})`
      : checkDisplayName(check);
    return `- [${check.startedAt ? ">" : " "}] ${name}`;
  });
  const body =
    checks.length === 0 ? "- _no checks reported_" : lines.length > 0 ? lines.join("\n") : "";

  return `${subject} checks — round ${round}: ${completed}/${checks.length} complete${body ? `\n\n${body}` : ""}`;
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

export type ChecksPollOutcome = "completed" | "fail_fast" | "timeout";

export interface ChecksPollResult {
  readonly outcome: ChecksPollOutcome;
  readonly checks: readonly MergedCheck[];
  readonly elapsedMs: number;
}

export interface PollPrChecksOptions {
  /** Report subject for progress lines, e.g. `PR #7` or `commit 5a7c407`. */
  subject: string;
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
  onUpdate?: (msg: ToolResult) => void;
}

/**
 * Poll the commit's combined-status and check-runs APIs until the wait
 * semantics are met: return on any failure (immediately under fail-fast) or
 * when every check is complete (pass/skipped). Emits a compact list of
 * in-flight checks via `onUpdate` each round.
 *
 * A failed round (network, auth) does not end the wait — the error is kept
 * and polling continues, so a transient blip or a CI system that has not
 * reported anything yet cannot be mistaken for a completed check set. Only
 * when no round ever succeeded by the deadline is the last error thrown.
 */
export async function pollPrChecks(options: PollPrChecksOptions): Promise<ChecksPollResult> {
  const { subject, owner, repo, headSha, failFast, checks, signal, onUpdate } = options;
  const intervalMs = options.intervalMs ?? CHECKS_POLL_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? CHECKS_WATCH_DEADLINE_MS;

  const watchStart = Date.now();
  let lastChecks: readonly MergedCheck[] = [];
  let lastError: unknown;
  let everSucceeded = false;

  for (let round = 1; ; round++) {
    if (signal.aborted) throw new Error("PR checks polling was aborted");
    try {
      const [statuses, runs] = await Promise.all([
        checks.statuses(owner, repo, headSha, signal),
        checks.checkRuns(owner, repo, headSha, signal),
      ]);
      everSucceeded = true;
      lastChecks = mergeChecks(statuses, runs);
      if (options.event) {
        lastChecks = lastChecks.filter((c) => c.event === options.event);
      }
      onUpdate?.({
        content: [
          { type: "text", text: renderPrChecksList({ subject, round, checks: lastChecks }) },
        ],
        details: {},
      });
      if (lastChecks.every((c) => c.bucket !== "pending")) {
        return { outcome: "completed", checks: lastChecks, elapsedMs: Date.now() - watchStart };
      }
      if (failFast && lastChecks.some((c) => c.bucket === "fail")) {
        return { outcome: "fail_fast", checks: lastChecks, elapsedMs: Date.now() - watchStart };
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

/** Job conclusions that count as "did not succeed" for CI result reporting. */
const FAILED_JOB_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
  "cancelled",
]);

export function statusIcon(conclusion: string | null): string {
  switch (conclusion) {
    case "success": {
      return "✅";
    }
    case "failure": {
      return "❌";
    }
    case "cancelled": {
      return "🚫";
    }
    case "skipped": {
      return "⏭️";
    }
    case "timed_out": {
      return "⏰";
    }
    case "action_required": {
      return "⚠️";
    }
    default: {
      return "🔄";
    }
  }
}

/** One Actions job that did not succeed, for the FAILED report details. */
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
  readonly status: "success" | "failure" | "pending";
  readonly text: string;
  readonly failedJobs: readonly FailedActionJob[];
}

/**
 * Turn a poll result into the final report. Verdict comes from the checks
 * buckets alone (so external CI such as Azure counts); Actions jobs are
 * display-only enrichment. Pure — no network.
 */
export function renderChecksVerdict(options: {
  /** Report subject, e.g. `PR #123` or `commit 5a7c407`. */
  subject: string;
  poll: ChecksPollResult;
  /** All Actions jobs of the head commit; failed/incomplete ones are listed. */
  actionJobs?: readonly ActionJob[];
  /** Set when the Actions job fetch failed; the verdict stays untouched. */
  enrichmentError?: string;
}): ChecksVerdict {
  const { subject, poll, actionJobs, enrichmentError } = options;
  const totalChecks = poll.checks.length;
  const failed = poll.checks.filter((c) => c.bucket === "fail");
  const pending = poll.checks.filter((c) => c.bucket === "pending");

  if (failed.length === 0 && poll.outcome === "completed") {
    return {
      status: "success",
      text: `## ${subject} CI Checks - PASSED\n\nAll ${totalChecks} check(s) passed.`,
      failedJobs: [],
    };
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

    const lines = failed.map(
      (c) =>
        `- ${statusIcon("failure")} **${checkDisplayName(c)}**${c.link ? ` — [view check](${c.link})` : ""}`,
    );
    for (const j of failedJobs) {
      lines.push(
        `  - ${statusIcon(j.conclusion)} job **${j.jobName}** (${j.conclusion}) — [job #${j.jobId}](${j.jobUrl ?? j.runUrl})`,
        `    - workflow: [${j.runName} (#${j.runId})](${j.runUrl})`,
      );
    }
    if (enrichmentError) lines.push(`  - _Actions job details unavailable: ${enrichmentError}_`);
    if (pending.length > 0) lines.push(`\n_${pending.length} other check(s) still in flight._`);

    return {
      status: "failure",
      text:
        `## ${subject} CI Checks - FAILED\n\n` +
        `${failed.length} of ${totalChecks} check(s) failed:\n\n${lines.join("\n")}`,
      failedJobs,
    };
  }

  const waitedMinutes = Math.max(1, Math.round(poll.elapsedMs / 60_000));
  const pendingLines = pending.map(
    (c) => `- [${c.startedAt ? ">" : " "}] ${c.link ? `[${c.name}](${c.link})` : c.name}`,
  );
  return {
    status: "pending",
    text:
      `## ${subject} CI Checks - STILL IN FLIGHT\n\n` +
      `${pending.length} of ${totalChecks} check(s) still incomplete after ~${waitedMinutes}m:\n\n` +
      (pendingLines.length > 0 ? pendingLines.join("\n") : "- _no checks reported_"),
    failedJobs: [],
  };
}

/**
 * Shared wait core of `wait-github-pr-checks` and `wait-github-commit-checks`:
 * poll the commit's checks, enrich FAILED reports with Actions job details
 * (display-only), render the verdict. The caller resolves repo/headSha;
 * `subject` formats the report header.
 */
export async function waitChecksReport(options: {
  checks: GithubChecksClient;
  subject: string;
  owner: string;
  repo: string;
  headSha: string;
  failFast: boolean;
  event?: string;
  signal: AbortSignal | undefined;
  onUpdate: ((msg: ToolResult) => void) | undefined;
  params: unknown;
  pendant?: ToolPendant;
}): Promise<ToolResult> {
  const { subject, owner, repo, headSha, failFast, event, signal, onUpdate, params, pendant } =
    options;

  // 轮询层要求非空 signal；框架可能不给时构造一个占位的（从不取消）。
  const pollSignal = signal ?? new AbortController().signal;

  const poll = await pollPrChecks({
    subject,
    owner,
    repo,
    headSha,
    failFast,
    event,
    checks: options.checks,
    signal: pollSignal,
    onUpdate,
  });

  // Actions job 详情只做展示补充，不影响判定（判定来自 checks bucket，
  // 覆盖 Azure 等外部 CI）。抓取失败时降级为提示，不推翻结论。
  let actionJobs: readonly ActionJob[] | undefined;
  let enrichmentError: string | undefined;
  if (poll.checks.some((c) => c.bucket === "fail")) {
    try {
      actionJobs = await options.checks.actionJobs(owner, repo, headSha, pollSignal);
    } catch (error) {
      enrichmentError = error instanceof Error ? error.message : "Actions job details unavailable";
    }
  }

  const verdict = renderChecksVerdict({ subject, poll, actionJobs, enrichmentError });
  return {
    content: [{ type: "text", text: verdict.text }],
    details: {
      status: verdict.status,
      totalChecks: poll.checks.length,
      checks: poll.checks,
      failedJobs: verdict.failedJobs,
      input: params,
      ...(pendant && { pendant }),
    },
  };
}
