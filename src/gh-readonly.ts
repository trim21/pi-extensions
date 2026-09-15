/**
 * GitHub Read-Only Tools Extension
 *
 * Provides individual read-only tools for GitHub operations using the system's `gh` CLI.
 *
 * Tools:
 *   - read-github-issue: Get issue details
 *   - list-github-issues: List or search issues
 *   - read-github-issue-comments: Get issue comments
 *   - read-github-pr: Get PR details
 *   - list-github-prs: List or search PRs
 *   - read-github-pr-diff: Get PR diff
 *   - read-github-pr-status: Get PR status checks
 *   - read-github-pr-comments: Get PR comments
 *   - read-github-ci-logs: Get CI workflow run logs
 *   - read-github-workflow-runs: List workflow runs
 *   - get-github-workflow-jobs: Get workflow run jobs
 *   - read-github-repo: Get repo info
 *   - list-github-releases: List releases
 *   - read-github-release: Get release details
 *   - download-github-release-assets: Download a release's assets with gh credentials
 *   - wait-github-pr-checks: Watch PR CI checks
 *   - wait-github-commit-checks: Watch CI checks of a commit (no PR required)
 *   - watch-github-run: Watch a workflow run
 *
 * Install:
 *   cp gh-readonly.ts ~/.pi/agent/extensions/
 *
 * Or for project-local:
 *   cp gh-readonly.ts .pi/extensions/
 *
 * Proxy (for the gh CLI and for the octokit-backed search/checks requests):
 *   ~/.pi/agent/proxy.json: { "proxy": "http://127.0.0.1:7890", "noProxy": "localhost" }
 *   HTTPS_PROXY / HTTP_PROXY / ALL_PROXY and NO_PROXY are used instead for the
 *   fields the config file leaves out. The config is read once per process.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  type RunJob,
} from "./lib/github.js";
import { type ToolPendant } from "./lib/pendant.js";
import { createHttpProxy } from "./lib/proxy.js";
import { createSeqState } from "./lib/seq-state.js";

/**
 * 代理配置（~/.pi/agent/proxy.json，回退到 HTTP(S)_PROXY 环境变量）在本模块内共享：
 * `gh` 子进程与 octokit 请求都从这里取，配置只在首次使用时读一次。
 */
const httpProxy = createHttpProxy();

interface GhResult {
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

// ── helpers ──────────────────────────────────────────────────────────────────

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

function repoArgs(repo?: string): string[] {
  return repo ? ["--repo", repo] : [];
}

/**
 * `gh api` for a JSON-array endpoint, following pagination. The REST API pages
 * these lists at 30 items by default, so a single page silently drops the rest;
 * `--slurp` is required because `--paginate` alone prints the pages back to back
 * (not valid JSON), and the page arrays are flattened back into one list.
 */
async function ghApiList(
  path: string,
  ctx: { cwd?: string; signal?: AbortSignal; input?: unknown },
): Promise<unknown[]> {
  const out = await ghExec(["api", "--paginate", "--slurp", path], ctx);
  return Value.Parse(Type.Array(Type.Array(Type.Unknown())), JSON.parse(out)).flat();
}

/** Split `OWNER/REPO`; throws when the name doesn't have exactly one slash. */
function splitRepo(nameWithOwner: string): { owner: string; repo: string } {
  const slash = nameWithOwner.indexOf("/");
  if (slash <= 0 || slash === nameWithOwner.length - 1 || nameWithOwner.includes("/", slash + 1)) {
    throw new Error(`invalid repository: ${nameWithOwner} (expected OWNER/REPO)`);
  }
  return { owner: nameWithOwner.slice(0, slash), repo: nameWithOwner.slice(slash + 1) };
}

/** Parse a positive integer toolcall parameter (run/job ids are numbers or numeric strings). */
function toPositiveId(value: number | string, name: string): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`invalid ${name}: ${String(value)} (expected a positive integer)`);
  }
  return id;
}

// ── runtime validation schemas for JSON.parse results ───────────────────────

const repoViewSchema = Type.Object({ nameWithOwner: Type.String() });

const prHeadSchema = Type.Object({ headRefOid: Type.String() });

/** `gh release view --json tagName,assets` 里本工具真正读取的字段。 */
const releaseViewSchema = Type.Object({
  tagName: Type.String(),
  assets: Type.Array(Type.Object({ name: Type.String(), size: Type.Number() })),
});

function truncate(
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
function toToolResult(
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
function subtitlePendant<IdKey extends string = never>(
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

interface ListFilters {
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
 * in `./lib/github.ts` handles them with state values (`all`, and `merged` for
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

async function listGithub(
  kind: "issue" | "pr",
  params: ListFilters,
  ctx: { cwd?: string; signal?: AbortSignal; input?: unknown },
): Promise<string> {
  return ghExec(listGithubArgs(kind, params), ctx);
}

/** Run a keyword search through the octokit client and render the rows. */
async function searchList(
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

// ── CI helpers ───────────────────────────────────────────────────────────────

// 模块级串行状态：同一资源（如 CI 日志）的请求排队执行，配合函数内部的
// 缓存检查避免重复网络请求。闭包状态不与其他扩展共享，key 无需全局前缀。
const seq = createSeqState();

/**
 * `OWNER/REPO` from a job's `run_url`
 * (`https://api.github.com/repos/OWNER/REPO/actions/runs/123`). The path is
 * parsed as a URL rather than pattern-matched, and GitHub canonicalizes the
 * owner/repo casing in these fields — so this is the spelling to key the log
 * cache on, independent of whatever `repo` the caller passed.
 */
export function repoFromRunUrl(runUrl: string): string {
  const segments = new URL(runUrl).pathname.split("/").filter(Boolean);
  const reposAt = segments.indexOf("repos");
  const ownerAndRepo = reposAt === -1 ? [] : segments.slice(reposAt + 1, reposAt + 3);
  if (ownerAndRepo.length !== 2) {
    throw new Error(`unexpected run_url (expected /repos/<owner>/<repo>/...): ${runUrl}`);
  }
  return ownerAndRepo.join("/");
}

/** Absolute path of the raw job log cache file written by `getJobLog`. */
export function jobLogPath(repo: string, runId: string, jobId: number): string {
  const { owner, repo: name } = splitRepo(repo);
  return join(homedir(), ".cache", "pi", "github", "ci-logs", owner, name, runId, `${jobId}.log`);
}

/**
 * Directory the release assets of one release are downloaded into:
 * `~/.cache/pi/github/releases/<owner>/<repo>/<tag>/`.
 *
 * A tag is a git ref name and may contain `/`; only the characters that are safe
 * in one path segment survive, so a tag can never escape its own directory.
 */
export function releaseAssetDir(repo: string, tag: string): string {
  const { owner, repo: name } = splitRepo(repo);
  const safeTag = tag.replaceAll(/[^A-Za-z0-9._+-]/g, "_").replace(/^\.+$/, "_");
  return join(homedir(), ".cache", "pi", "github", "releases", owner, name, safeTag);
}

async function getJobLog(
  job: RunJob,
  signal: AbortSignal | undefined,
  cwd: string | undefined,
  input?: unknown,
): Promise<string> {
  // The log download only accepts a job id, and the cache is keyed on the
  // canonical repo/run from the job itself, not on the caller's `repo` string.
  const repo = repoFromRunUrl(job.run_url);
  const cacheFile = jobLogPath(repo, String(job.run_id), job.id);
  const cacheDir = dirname(cacheFile);

  // 同一 cache 文件的请求串行执行：后一个进入时缓存已写入，直接命中缓存，
  // 不会重复发网络请求；串行也保证不会有两个并发写同一 cache 文件。
  return seq.execute(cacheFile, async () => {
    // Check file cache
    try {
      return await readFile(cacheFile, "utf8");
    } catch {
      // Not cached, fetch from GitHub
    }

    // `gh api` refuses to print responses that contain terminal escape
    // sequences unless `--allow-escape-sequences` is passed. Job logs carry
    // ANSI color codes, so without this flag the download always fails with
    // "the response contains terminal escape sequences; pass
    // --allow-escape-sequences to output it anyway". The raw bytes are kept
    // as-is (the file is the log exactly as GitHub delivers it); the tool never
    // echoes them, and the TUI strips ANSI when rendering tool results.
    const log = await ghExec(
      ["api", "--allow-escape-sequences", `/repos/${repo}/actions/jobs/${job.id}/logs`],
      {
        cwd,
        signal,
        input,
      },
    );

    // Write to cache
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, log);

    return log;
  });
}

async function resolveRepo(
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

/** A step's line span in the raw job log: 0-based `start`, exclusive `end`. */
export interface StepSpan {
  start: number;
  end: number;
}

/** The part of a step the log index needs. `RunJobStep` satisfies it. */
export interface StepRef {
  number: number;
  name: string;
  conclusion?: string | null;
  started_at?: string | null;
}

/** A `##[group]Run …` / `##[group]Post Run …` line: the header of one executed step. */
interface StepHeader {
  /** 0-based index of the `##[group]` line. */
  line: number;
  /** Header text with the `Run ` / `Post Run ` prefix stripped. */
  action: string;
  /** Runner timestamp on that line (epoch ms), null when unparsable. */
  timestamp: number | null;
}

/** Runner timestamp every log line starts with: `2026-08-05T16:36:08.1842645Z `. */
const LOG_TIMESTAMP_RE = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;
const HEADER_PREFIX_RE = /^(Run |Post Run )/;

/**
 * The runner writes a step's header within ~1.6s of the step's API `started_at`
 * (the API truncates its timestamps to whole seconds), so a header inside this
 * window is evidence of the step it belongs to.
 */
const HEADER_WINDOW_MS = 5_000;
/** An exact name match proves the header belongs to that step. */
const NAME_MATCH_SCORE = 4;
/** Weight of a header inside the step's start window. */
const TIME_MATCH_SCORE = 2;

function headerTimestamp(line: string): number | null {
  const match = LOG_TIMESTAMP_RE.exec(line);
  if (match === null) return null;
  const ms = Date.parse(match[1]);
  return Number.isNaN(ms) ? null : ms;
}

/** Collect the depth-1 `Run ` / `Post Run ` headers, in log order. */
function stepHeaders(lines: string[]): StepHeader[] {
  const headers: StepHeader[] = [];
  let depth = 0;
  for (const [i, line] of lines.entries()) {
    if (line.includes("##[endgroup]")) {
      if (depth > 0) depth--;
      continue;
    }
    if (!line.includes("##[group]")) continue;
    depth++;
    if (depth !== 1) continue;
    const name = /##\[group\](.*)/.exec(line)?.[1].trim() ?? "";
    if (HEADER_PREFIX_RE.test(name)) {
      headers.push({
        line: i,
        action: name.replace(HEADER_PREFIX_RE, "").trim(),
        timestamp: headerTimestamp(line),
      });
    }
  }
  return headers;
}

/** How well a step explains a header — 0 means "no evidence, don't guess". */
function headerScore(step: StepRef, header: StepHeader): number {
  let score = 0;
  const named = step.name.replace(HEADER_PREFIX_RE, "").trim();
  if (HEADER_PREFIX_RE.test(step.name) && named === header.action) {
    score += NAME_MATCH_SCORE;
  }
  const started = step.started_at == null ? NaN : Date.parse(step.started_at);
  if (!Number.isNaN(started) && header.timestamp !== null) {
    const delta = header.timestamp - started;
    if (delta >= 0 && delta <= HEADER_WINDOW_MS) {
      score += TIME_MATCH_SCORE * (1 - delta / HEADER_WINDOW_MS);
    }
  }
  return score;
}

/**
 * Align steps with headers: an order-preserving best-scoring matching, where
 * either side may be left unmatched. Only pairs with real evidence are matched,
 * so a step whose block cannot be identified gets no span instead of a guess.
 *
 * Name evidence disappears as soon as the workflow names a step with `name:`
 * (the API name is then the custom one, while the log header carries the action
 * or command), which is why the timestamps matter too. Headers belonging to a
 * composite action's *internal* steps carry no evidence for any API step, so
 * they stay unmatched and are absorbed into the enclosing step's span.
 */
function alignStepsToHeaders(
  steps: readonly StepRef[],
  headers: StepHeader[],
): Map<number, number> {
  const n = steps.length;
  const m = headers.length;
  // Equal-scoring alignments are decided in favour of the earlier step: a step
  // whose output the runner never logged (post steps, "Complete job") comes last
  // in step order, so a header claimed by both belongs to the earlier one. A
  // step that ran always emits its header before the next step starts, which
  // leaves several steps competing for one header whenever the API timestamps
  // (whole seconds) collapse them into the same second.
  const TIE_BREAK = 1e-6;
  const scores = steps.map((step, i) =>
    headers.map((header) => {
      const score = headerScore(step, header);
      return score > 0 ? score + TIE_BREAK * (n - i) : 0;
    }),
  );
  // best[i][j]: score of aligning the first i steps with the first j headers.
  const best: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  const paired: boolean[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => false),
  );

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const pairing = scores[i - 1][j - 1];
      const withPairing = pairing > 0 ? best[i - 1][j - 1] + pairing : -Infinity;
      if (withPairing >= best[i - 1][j] && withPairing >= best[i][j - 1]) {
        best[i][j] = withPairing;
        paired[i][j] = true;
      } else {
        best[i][j] = Math.max(best[i - 1][j], best[i][j - 1]);
      }
    }
  }

  const assignment = new Map<number, number>(); // step number -> header index
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (paired[i][j]) {
      assignment.set(steps[i - 1].number, j - 1);
      i--;
      j--;
    } else if (best[i - 1][j] >= best[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return assignment;
}

/** Exclusive end index with trailing blank lines dropped, so a span slices to real text. */
function trimTrailingBlankLines(lines: string[], start: number, end: number): number {
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return end;
}

/**
 * Locate a job's steps in its raw log: each executed step emits a depth-1
 * `##[group]Run <x>` / `##[group]Post Run <x>` header, and its block runs from
 * that header up to the next executed step's header. Everything in between —
 * the action's own `::group::` output, a composite action's internal step
 * headers — belongs to the enclosing step.
 *
 * "Set up job" emits no header: it owns the runner preamble before the first
 * header. Steps with no header of their own (skipped steps, post steps the
 * runner never logged, "Complete job") get no span.
 */
export function stepLineSpans(log: string, apiSteps: readonly StepRef[]): Map<number, StepSpan> {
  const lines = log.split("\n");
  const headers = stepHeaders(lines);
  const spans = new Map<number, StepSpan>();

  // "Set up job" is the runner's own preamble and never takes part in matching:
  // its start window overlaps the first real step's header.
  const preamble = apiSteps.find((s) => s.number === 1 && s.name === "Set up job");
  if (preamble !== undefined) {
    const end = trimTrailingBlankLines(lines, 0, headers[0]?.line ?? lines.length);
    spans.set(preamble.number, { start: 0, end });
  }

  // A skipped step never started, so it emitted no header — and its name often
  // repeats another step's ("Clear build" twice, "Post Run <action>" next to
  // its "Run <action>"), which would let it steal that step's block.
  const assignment = alignStepsToHeaders(
    apiSteps.filter((s) => s !== preamble && s.conclusion !== "skipped"),
    headers,
  );
  const placed = [...assignment]
    .map(([number, headerIndex]) => ({ number, line: headers[headerIndex].line }))
    .toSorted((a, b) => a.line - b.line);

  for (const [index, step] of placed.entries()) {
    const end = trimTrailingBlankLines(lines, step.line, placed[index + 1]?.line ?? lines.length);
    spans.set(step.number, { start: step.line, end });
  }

  return spans;
}

/** Text of `stepNumber` in its raw log, or null when the step never ran. */
export function extractStepFromLog(
  log: string,
  stepNumber: number,
  apiSteps: readonly { number: number; name: string }[],
): string | null {
  const span = stepLineSpans(log, apiSteps).get(stepNumber);
  if (span === undefined) return null;
  return log.split("\n").slice(span.start, span.end).join("\n").trimEnd();
}

// ── ci-logs rendering (pure, testable) ──────────────────────────────────────

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

/** One step of a job, indexed into the job's raw log file. */
export interface CiLogsStepIndex {
  number: number;
  name: string;
  conclusion: string | null;
  /** 1-based inclusive line range of this step's block in `log_file`. */
  start_line?: number;
  end_line?: number;
}

/** A job's steps plus the raw log file holding their output. */
export interface CiLogsJobIndex {
  name: string;
  id: number;
  status: string;
  conclusion: string | null;
  log_file: string;
  steps: CiLogsStepIndex[];
}

/**
 * Index a job's steps into its raw log: every step that produced a log block
 * gets the `[start_line, end_line]` range (1-based, inclusive) of that block in
 * `log_file`; steps that never ran (skipped, or absent from the log) carry no
 * range. The step content itself is not returned — the model reads it out of
 * the file.
 */
export function jobLogIndex(job: RunJob, rawLog: string): CiLogsJobIndex {
  const spans = stepLineSpans(rawLog, job.steps);
  return {
    name: job.name,
    id: job.id,
    status: job.status,
    conclusion: job.conclusion,
    log_file: jobLogPath(repoFromRunUrl(job.run_url), String(job.run_id), job.id),
    steps: job.steps.map((s) => {
      const span = spans.get(s.number);
      return {
        number: s.number,
        name: s.name,
        conclusion: s.conclusion,
        ...(span && span.end > span.start && { start_line: span.start + 1, end_line: span.end }),
      };
    }),
  };
}

// ── pr checks watch (pure rendering + poll loop) ────────────────────────────

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

// ── GitHub REST client ───────────────────────────────────────────────────────

/** Toolcall input for the handlers that read through the REST API. */
interface PrStatusParams {
  number: number | string;
  repo?: string;
}

interface RunIdParams {
  run_id: number | string;
  repo?: string;
}

interface JobIdParams {
  job_id: number | string;
  repo?: string;
}

interface PrChecksWaitParams {
  number: number | string;
  repo?: string;
  fail_fast?: boolean;
}

interface CommitChecksWaitParams {
  commit: number | string;
  repo?: string;
  event?: string;
  fail_fast?: boolean;
}

interface ReleaseDownloadParams {
  repo?: string;
  tag?: string;
  pattern?: string;
  archive?: "zip" | "tar.gz";
}

/** What a toolcall handler receives from the framework. */
export interface ToolCall<Params> {
  params: Params;
  ctx: { cwd?: string };
  signal?: AbortSignal;
  /** Streaming progress updates, passed through as-is. */
  onUpdate?: (update: ToolResult) => void;
}

/**
 * The GitHub reads that go through the REST API, with the HTTP layer injected:
 * production hands in the proxy-aware fetch, tests hand in a stub and never
 * touch the network. Handlers that only shell out to `gh` stay plain functions.
 *
 * `fetch` is a property (not module state) so a caller that needs different HTTP
 * behavior — a test, another host — constructs its own instance.
 */
export class GhClient {
  readonly fetch: typeof globalThis.fetch;
  private readonly search: GithubSearch;
  private readonly checks: GithubChecksClient;

  constructor(fetchImpl: typeof globalThis.fetch = httpProxy.fetch) {
    this.fetch = fetchImpl;
    this.search = createGithubSearch({ fetch: fetchImpl });
    this.checks = createGithubChecks({ fetch: fetchImpl });
  }

  /** `list-github-issues` / `list-github-prs`: browse through `gh`, search through the API. */
  private async list(kind: "issue" | "pr", call: ToolCall<ListFilters>): Promise<ToolResult> {
    const { params, ctx, signal } = call;
    const result = toToolResult(
      params.keywords
        ? await searchList(kind, params, this.search)
        : await listGithub(kind, params, { cwd: ctx.cwd, signal, input: params }),
      params,
    );
    result.details.pendant = subtitlePendant(params);
    return result;
  }

  listIssues(call: ToolCall<ListFilters>): Promise<ToolResult> {
    return this.list("issue", call);
  }

  listPrs(call: ToolCall<ListFilters>): Promise<ToolResult> {
    return this.list("pr", call);
  }

  /**
   * `read-github-pr-status`: the PR head commit's checks as a snapshot. Same read
   * path as the wait tools (octokit), but it never polls — pending checks come
   * back as-is.
   */
  async prStatus(call: ToolCall<PrStatusParams>): Promise<ToolResult> {
    const { params, ctx, signal } = call;
    const { number, repo } = params;
    const pullNumber = toPositiveId(number, "number");
    const pendant = subtitlePendant(params, "number");
    const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
    const { owner, repo: name } = splitRepo(effectiveRepo);

    const pollSignal = signal ?? new AbortController().signal;
    const headSha = await this.checks.pullHead(owner, name, pullNumber, pollSignal);
    const [statuses, checkRuns] = await Promise.all([
      this.checks.statuses(owner, name, headSha, pollSignal),
      this.checks.checkRuns(owner, name, headSha, pollSignal),
    ]);
    const checks = mergeChecks(statuses, checkRuns).map((check) => ({
      name: check.name,
      bucket: check.bucket,
      event: check.event,
      run_id: check.runId,
      job_id: check.jobId,
      url: check.link,
    }));

    const payload = { pr: pullNumber, repo: effectiveRepo, head_sha: headSha, checks };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: { ...payload, input: params, ...(pendant && { pendant }) },
    };
  }

  /** `get-github-workflow-jobs`: every job of a run, all pages. */
  async workflowJobs(call: ToolCall<RunIdParams>): Promise<ToolResult> {
    const { params, ctx, signal } = call;
    const runId = toPositiveId(params.run_id, "run_id");
    const effectiveRepo = await resolveRepo(params.repo, signal, ctx.cwd, params);
    const { owner, repo: name } = splitRepo(effectiveRepo);

    const jobs = await this.checks.runJobs(owner, name, runId, signal);
    const result = toToolResult(JSON.stringify({ total_count: jobs.length, jobs }), params);
    result.details.pendant = subtitlePendant(params, "run_id");
    return result;
  }

  /** `read-github-ci-logs`: one job's raw log on disk plus its step line ranges. */
  async ciLogs(call: ToolCall<JobIdParams>): Promise<ToolResult> {
    const { params, ctx, signal, onUpdate } = call;
    const { job_id, repo } = params;
    const jobId = toPositiveId(job_id, "job_id");

    const pendant = subtitlePendant(params, "job_id");
    const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
    const { owner, repo: name } = splitRepo(effectiveRepo);

    const failure = (text: string): ToolResult => ({
      content: [{ type: "text", text }],
      details: { input: params, ...(pendant && { pendant }) },
    });

    let target: RunJob;
    try {
      target = await this.checks.job(owner, name, jobId, signal);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404) throw error;
      return failure(
        `Job ${jobId} not found in ${effectiveRepo} — job IDs come from \`get-github-workflow-jobs\`.`,
      );
    }

    if (target.status === "queued") {
      return failure(
        `Job "${target.name}" is still queued — no logs available yet. Use \`watch-github-run\` to wait for it to start, then retry.`,
      );
    }

    onUpdate?.({
      content: [{ type: "text", text: `Fetching log of job "${target.name}"...` }],
      details: {},
    });

    const rawLog = await getJobLog(target, signal, ctx.cwd, params);
    const index = jobLogIndex(target, rawLog);

    return {
      content: [{ type: "text", text: JSON.stringify(index, null, 2) }],
      details: { ...index, input: params, ...(pendant && { pendant }) },
    };
  }

  /** `wait-github-pr-checks`: poll the PR's head commit checks until they settle. */
  async waitPrChecks(call: ToolCall<PrChecksWaitParams>): Promise<ToolResult> {
    const { params, ctx, signal, onUpdate } = call;
    const { number, repo, fail_fast } = params;

    const pendant = subtitlePendant(params, "number");
    onUpdate?.({
      content: [{ type: "text", text: `Watching CI checks for PR #${number}...` }],
      details: {},
    });

    const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
    const { owner, repo: repoName } = splitRepo(effectiveRepo);

    const prOut = await ghExec(
      ["pr", "view", String(number), "--repo", effectiveRepo, "--json", "headRefOid"],
      { cwd: ctx.cwd, signal, input: params },
    );
    const { headRefOid } = Value.Parse(prHeadSchema, JSON.parse(prOut));

    return this.waitChecksReport({
      subject: `PR #${number}`,
      owner,
      repo: repoName,
      headSha: headRefOid,
      failFast: fail_fast === true,
      signal,
      onUpdate,
      params,
      pendant,
    });
  }

  /** `wait-github-commit-checks`: same, addressed by commit/branch/tag instead of a PR. */
  async waitCommitChecks(call: ToolCall<CommitChecksWaitParams>): Promise<ToolResult> {
    const { params, ctx, signal, onUpdate } = call;
    const { commit, repo, event, fail_fast } = params;

    const pendant = subtitlePendant(params, "commit");
    onUpdate?.({
      content: [{ type: "text", text: `Watching CI checks for commit ${commit}...` }],
      details: {},
    });

    const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
    const { owner, repo: repoName } = splitRepo(effectiveRepo);

    const pollSignal = signal ?? new AbortController().signal;
    const sha = await this.checks.headSha(owner, repoName, String(commit), pollSignal);

    return this.waitChecksReport({
      subject: `commit ${sha.slice(0, 7)}`,
      owner,
      repo: repoName,
      headSha: sha,
      failFast: fail_fast === true,
      event,
      signal,
      onUpdate,
      params,
      pendant,
    });
  }

  /**
   * Shared wait core of `wait-github-pr-checks` and
   * `wait-github-commit-checks`: poll the commit's checks, enrich FAILED
   * reports with Actions job details (display-only), render the verdict.
   * The caller resolves repo/headSha; `subject` formats the report header.
   */
  private async waitChecksReport(options: {
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
      checks: this.checks,
      signal: pollSignal,
      onUpdate,
    });

    // Actions job 详情只做展示补充，不影响判定（判定来自 checks bucket，
    // 覆盖 Azure 等外部 CI）。抓取失败时降级为提示，不推翻结论。
    let actionJobs: readonly ActionJob[] | undefined;
    let enrichmentError: string | undefined;
    if (poll.checks.some((c) => c.bucket === "fail")) {
      try {
        actionJobs = await this.checks.actionJobs(owner, repo, headSha, pollSignal);
      } catch (error) {
        enrichmentError =
          error instanceof Error ? error.message : "Actions job details unavailable";
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
}

// ── release asset download ───────────────────────────────────────────────────

/** One regular file in a release's download directory. */
interface ReleaseFile {
  name: string;
  path: string;
  bytes: number;
}

/** Split the comma-separated `pattern` toolcall parameter into gh pattern values. */
export function releasePatterns(pattern: string | undefined): string[] {
  if (pattern === undefined) return [];
  return pattern
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/**
 * The `gh release download` argv. `--skip-existing` is always on: the download
 * directory is a cache, and rewriting a file that is already there would pull
 * the ground out from under anything reading it.
 */
export function releaseDownloadArgs(options: {
  tag: string;
  repo: string;
  dir: string;
  patterns: readonly string[];
  archive?: "zip" | "tar.gz";
}): string[] {
  const { tag, repo, dir, patterns, archive } = options;
  const args = ["release", "download", tag, ...repoArgs(repo)];
  if (archive !== undefined) args.push("--archive", archive);
  for (const pattern of patterns) args.push("--pattern", pattern);
  args.push("--dir", dir, "--skip-existing");
  return args;
}

/** Regular files directly inside `dir`, with their sizes, sorted by name. */
async function listReleaseFiles(dir: string): Promise<ReleaseFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: ReleaseFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    const info = await stat(path);
    files.push({ name: entry.name, path, bytes: info.size });
  }
  return files.toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * `gh release download` answers this exact message when a `--pattern` matched no
 * asset. It is the only signal the CLI offers, so the enrichment below degrades
 * to gh's own error (still thrown) if the wording ever changes.
 */
const GH_NO_ASSET_MATCH = "no assets match the file pattern";

/**
 * `download-github-release-assets`: fetch a release's assets (or source archive)
 * into `releaseAssetDir` with the gh credentials, so private repositories work
 * and the shell sandbox's network limits do not apply.
 *
 * The tag is resolved through `gh release view` before downloading: a tag that
 * does not exist and a pattern that matched nothing are different answers, and
 * the release's own asset names are what the model needs to fix the second one.
 */
export async function downloadReleaseAssets(
  call: ToolCall<ReleaseDownloadParams>,
): Promise<ToolResult> {
  const { params, ctx, signal } = call;
  const patterns = releasePatterns(params.pattern);
  if (params.archive !== undefined && patterns.length > 0) {
    throw new Error(
      "pattern and archive are mutually exclusive (pick asset globs or the source archive)",
    );
  }

  const effectiveRepo = await resolveRepo(params.repo, signal, ctx.cwd, params);
  const view = Value.Parse(
    releaseViewSchema,
    JSON.parse(
      await ghExec(
        [
          "release",
          "view",
          ...(params.tag === undefined ? [] : [params.tag]),
          ...repoArgs(effectiveRepo),
          "--json",
          "tagName,assets",
        ],
        { cwd: ctx.cwd, signal, input: params },
      ),
    ),
  );

  const assetNames = view.assets.map((asset) => asset.name);
  const dir = releaseAssetDir(effectiveRepo, view.tagName);
  await mkdir(dir, { recursive: true });
  try {
    await ghExec(
      releaseDownloadArgs({
        tag: view.tagName,
        repo: effectiveRepo,
        dir,
        patterns,
        ...(params.archive !== undefined && { archive: params.archive }),
      }),
      { cwd: ctx.cwd, signal, input: params },
    );
  } catch (error) {
    // gh names the fault but not the choices; the release's asset list turns a
    // dead end into the next toolcall.
    if (error instanceof GhError && error.stderr.includes(GH_NO_ASSET_MATCH)) {
      throw new Error(
        `no asset of ${effectiveRepo}@${view.tagName} matched ${JSON.stringify(patterns)}; the release has: ${assetNames.join(", ") || "(no assets)"}`,
        { cause: error },
      );
    }
    throw error;
  }

  const files = await listReleaseFiles(dir);
  const payload = { repo: effectiveRepo, tag: view.tagName, dir, files };
  const pendant = subtitlePendant({ repo: effectiveRepo, tag: view.tagName }, "tag");

  if (files.length === 0 && params.archive === undefined) {
    return {
      content: [
        {
          type: "text",
          text: `Nothing to download from ${effectiveRepo}@${view.tagName}: the release has no assets (try archive for the source tarball)`,
        },
      ],
      details: {
        ...payload,
        available_assets: assetNames,
        input: params,
        ...(pendant && { pendant }),
      },
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: { ...payload, input: params, ...(pendant && { pendant }) },
  };
}

// ── tools ────────────────────────────────────────────────────────────────────

export default function ghReadonlyTools(pi: ExtensionAPI) {
  // Windows 上禁用：gh 可执行文件的探测（无扩展名 + POSIX 路径）与进程
  // 管理（SIGTERM 信号语义）都是 POSIX 假设，不做 Windows 适配。
  if (process.platform === "win32") {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("gh-readonly tools are disabled on Windows.", "warning");
    });
    return;
  }

  // Fail fast: the `gh` CLI is the only backend for these tools. Without it the
  // extension registers nothing and reports the problem at session start, so
  // the user gets one clear error instead of a dozen failing tool calls.
  if (!isGhAvailable()) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        "gh CLI not found in PATH: GitHub read-only tools are disabled. Install GitHub CLI (https://cli.github.com/) and reload the session.",
        "error",
      );
    });
    return;
  }

  const client = new GhClient();

  // ── read-github-issue ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-issue",
    label: "GitHub Issue",
    description: "Get details of a GitHub issue by number.",
    promptSnippet: "Read a GitHub issue",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "Issue number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const result = toToolResult(
        await ghExec(
          [
            "issue",
            "view",
            String(number),
            ...repoArgs(repo),
            "--json",
            "title,state,body,author,createdAt,updatedAt,closedAt,url,labels,assignees,comments,milestone,number",
          ],
          { cwd: ctx.cwd, signal, input: params },
        ),
        params,
      );
      result.details.pendant = subtitlePendant(params, "number");
      return result;
    },
  });

  // ── list-github-issues ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "list-github-issues",
    label: "GitHub Issues List",
    description:
      'List GitHub issues with optional filters and keyword search. When repo is omitted, keyword search runs across GitHub. Keyword search defaults to open issues — pass state="all" to include closed ones. Set fields to choose the columns of each result row.',
    promptSnippet: "List or search GitHub issues",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
      keywords: Type.Optional(Type.String({ description: "Search keywords (free text)" })),
      state: Type.Optional(
        Type.String({
          description:
            "open, closed, all (default: open; all applies to keyword search and covers closed too)",
        }),
      ),
      label: Type.Optional(Type.String({ description: "Filter by label" })),
      author: Type.Optional(Type.String({ description: "Filter by author" })),
      assignee: Type.Optional(
        Type.String({ description: "Filter by assignee (@me for yourself)" }),
      ),
      milestone: Type.Optional(Type.String({ description: "Filter by milestone" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 30, max 100)" })),
      fields: Type.Optional(
        Type.String({
          description:
            "Comma-separated columns for keyword-search rows (default: number,state,title,labels,updatedAt; adds repo when no repo given). Valid: number,state,title,url,author,labels,milestone,assignees,comments,repo,createdAt,updatedAt,closedAt",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return client.listIssues({ params, ctx, signal, onUpdate });
    },
  });

  // ── read-github-pr ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-pr",
    label: "GitHub PR",
    description: "Get details of a GitHub pull request by number.",
    promptSnippet: "Read a GitHub PR",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const result = toToolResult(
        await ghExec(
          [
            "pr",
            "view",
            String(number),
            ...repoArgs(repo),
            "--json",
            "title,state,body,author,createdAt,updatedAt,mergedAt,mergedBy,headRefName,baseRefName,url,additions,deletions,changedFiles,labels,assignees,reviewRequests,reviews,comments,number",
          ],
          { cwd: ctx.cwd, signal, input: params },
        ),
        params,
      );
      result.details.pendant = subtitlePendant(params, "number");
      return result;
    },
  });

  // ── list-github-prs ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "list-github-prs",
    label: "GitHub PRs List",
    description:
      'List GitHub pull requests with optional filters and keyword search. When repo is omitted, keyword search runs across GitHub. Keyword search defaults to open PRs — pass state="merged", state="closed" (merged excluded) or state="all" to broaden. Set fields to choose the columns of each result row.',
    promptSnippet: "List or search GitHub PRs",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
      keywords: Type.Optional(Type.String({ description: "Search keywords (free text)" })),
      state: Type.Optional(
        Type.String({
          description:
            "open, closed, merged, all (default: open; all applies to keyword search and covers open + closed + merged)",
        }),
      ),
      label: Type.Optional(Type.String({ description: "Filter by label" })),
      author: Type.Optional(Type.String({ description: "Filter by author" })),
      assignee: Type.Optional(
        Type.String({ description: "Filter by assignee (@me for yourself)" }),
      ),
      milestone: Type.Optional(Type.String({ description: "Filter by milestone" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 30, max 100)" })),
      fields: Type.Optional(
        Type.String({
          description:
            "Comma-separated columns for keyword-search rows (default: number,state,title,labels,updatedAt; adds repo when no repo given). Valid: number,state,title,url,author,labels,milestone,assignees,comments,repo,createdAt,updatedAt,closedAt,mergedAt",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return client.listPrs({ params, ctx, signal, onUpdate });
    },
  });

  // ── read-github-pr-diff ────────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-pr-diff",
    label: "GitHub PR Diff",
    description: "Get the diff of a GitHub pull request.",
    promptSnippet: "Read a GitHub PR diff",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const args = ["pr", "diff", String(number), ...repoArgs(repo)];
      const result = toToolResult(
        await ghExec(args, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
      result.details.pendant = subtitlePendant(params, "number");
      return result;
    },
  });

  // ── read-github-pr-status ──────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-pr-status",
    label: "GitHub PR Status",
    description:
      "Get the current checks of a pull request's head commit as JSON {pr, repo, head_sha, checks:[{name, bucket, event, run_id, job_id, url}]}. `bucket` is pass / fail / pending / skipped; Actions checks carry the `run_id` and `job_id` behind them (null for other CI), which is what read-github-ci-logs and get-github-workflow-jobs take. Returns the snapshot immediately without waiting — use wait-github-pr-checks to block until the checks finish.",
    promptSnippet: "Read GitHub PR status checks",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return client.prStatus({ params, ctx, signal, onUpdate });
    },
  });

  // ── read-github-pr-comments ────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-pr-comments",
    label: "GitHub PR Comments",
    description:
      "Get review comments on a GitHub pull request. Set reviews=true for inline code review comments with diff_hunk.",
    promptSnippet: "Read GitHub PR comments",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      reviews: Type.Optional(
        Type.Boolean({
          description:
            "If true, returns inline code review comments (with diff_hunk, path, line) via API. Default: false (returns issue comments).",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo, reviews } = params;
      let out: string;
      if (reviews) {
        const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);

        const [reviewComments, reviewSummaries] = await Promise.all([
          ghApiList(`/repos/${effectiveRepo}/pulls/${String(number)}/comments`, {
            cwd: ctx.cwd,
            signal,
            input: params,
          }),
          ghApiList(`/repos/${effectiveRepo}/pulls/${String(number)}/reviews`, {
            cwd: ctx.cwd,
            signal,
            input: params,
          }),
        ]);

        out = JSON.stringify(
          {
            reviews: reviewSummaries,
            comments: reviewComments,
          },
          null,
          2,
        );
      } else {
        out = await ghExec(
          ["pr", "view", String(number), ...repoArgs(repo), "--json", "comments"],
          {
            cwd: ctx.cwd,
            signal,
            input: params,
          },
        );
      }
      const { text, truncated } = truncate(out);
      const pendant = subtitlePendant(params, "number");
      return {
        content: [{ type: "text", text }],
        details: { input: params, truncated, ...(pendant && { pendant }) },
      };
    },
  });

  // ── read-github-issue-comments ─────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-issue-comments",
    label: "GitHub Issue Comments",
    description: "Get comments on a GitHub issue.",
    promptSnippet: "Read GitHub issue comments",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "Issue number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const result = toToolResult(
        await ghExec(["issue", "view", String(number), ...repoArgs(repo), "--json", "comments"], {
          cwd: ctx.cwd,
          signal,
          input: params,
        }),
        params,
      );
      result.details.pendant = subtitlePendant(params, "number");
      return result;
    },
  });

  // ── list-github-workflow-runs ──────────────────────────────────────────────
  pi.registerTool({
    name: "list-github-workflow-runs",
    label: "GitHub Workflow Runs",
    description: "List GitHub Actions workflow runs.",
    promptSnippet: "List GitHub workflow runs",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
      status: Type.Optional(
        Type.String({ description: "Filter by status: success, failure, cancelled, etc." }),
      ),
      workflow: Type.Optional(Type.String({ description: "Filter by workflow name or file" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { repo, limit, status, workflow } = params;
      const args = ["run", "list", ...repoArgs(repo)];
      if (limit) args.push("--limit", String(limit));
      if (status) args.push("--status", status);
      if (workflow) args.push("--workflow", workflow);
      const result = toToolResult(
        await ghExec(args, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
      result.details.pendant = subtitlePendant(params);
      return result;
    },
  });

  // ── read-github-ci-logs ────────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-ci-logs",
    label: "GitHub CI Logs",
    description:
      "Download one GitHub Actions job's CI log by job ID and index its steps. Returns JSON {name, id, status, conclusion, log_file, steps:[{number, name, conclusion, start_line?, end_line?}]}: `log_file` is the job's complete raw log on disk (runner timestamps and ANSI kept, exactly as GitHub delivers it) and each step carries the 1-based inclusive line range of its block inside that file. Read the content out of the file yourself (read/grep with offset/limit) — it is not echoed back. Get the job IDs from get-github-workflow-jobs, then call this once per job you need." +
      " Note: queued jobs have no logs yet; use watch-github-run to wait for completion.",
    promptSnippet: "Read GitHub CI logs",
    parameters: Type.Object({
      job_id: Type.Union([Type.Number(), Type.String()], {
        description: "Job ID, from get-github-workflow-jobs.",
      }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return client.ciLogs({ params, ctx, signal, onUpdate });
    },
  });

  // ── get-github-workflow-jobs ──────────────────────────────────────────────
  pi.registerTool({
    name: "get-github-workflow-jobs",
    label: "GitHub Workflow Jobs",
    description:
      "Get every job of a workflow run as JSON {total_count, jobs:[{id, run_id, run_url, name, status, conclusion, html_url, steps:[{name, number, status, conclusion, started_at}]}]}. Paginated server-side, so runs with more than 30 jobs return all of them. Use the `id` with read-github-ci-logs after read-github-pr-status / wait-github-commit-checks did not already give you a job id.",
    promptSnippet: "Get GitHub workflow run jobs",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return client.workflowJobs({ params, ctx, signal, onUpdate });
    },
  });

  // ── read-github-repo ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-repo",
    label: "GitHub Repo",
    description: "Get repository information.",
    promptSnippet: "Read GitHub repo info",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { repo } = params;
      const args = ["repo", "view"];
      if (repo) args.push(repo);
      const result = toToolResult(
        await ghExec(args, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
      result.details.pendant = subtitlePendant(params);
      return result;
    },
  });

  // ── list-github-releases ───────────────────────────────────────────────────
  pi.registerTool({
    name: "list-github-releases",
    label: "GitHub Releases List",
    description: "List GitHub releases.",
    promptSnippet: "List GitHub releases",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { repo, limit } = params;
      const args = ["release", "list", ...repoArgs(repo)];
      if (limit) args.push("--limit", String(limit));
      const result = toToolResult(
        await ghExec(args, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
      result.details.pendant = subtitlePendant(params);
      return result;
    },
  });

  // ── read-github-release ────────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-release",
    label: "GitHub Release",
    description: "Get details of a specific GitHub release by tag.",
    promptSnippet: "Read a GitHub release",
    parameters: Type.Object({
      tag: Type.String({ description: "Release tag name" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { tag, repo } = params;
      const result = toToolResult(
        await ghExec(["release", "view", tag, ...repoArgs(repo)], {
          cwd: ctx.cwd,
          signal,
          input: params,
        }),
        params,
      );
      result.details.pendant = subtitlePendant(params, "tag");
      return result;
    },
  });

  // ── download-github-release-assets ────────────────────────────────────────
  pi.registerTool({
    name: "download-github-release-assets",
    label: "GitHub Release Download",
    description:
      "Download a GitHub release's assets (or its source archive) into " +
      "~/.cache/pi/github/releases/<owner>/<repo>/<tag>/ using the gh CLI's credentials, " +
      "so private repositories and large binaries work where a plain HTTP fetch cannot. " +
      "Files already in that directory are kept, never re-fetched. The result is the JSON " +
      "summary {repo, tag, dir, files:[{name, path, bytes}]} listing everything now in the " +
      "directory; file contents are not echoed. Read the entries you need from `path`.",
    promptSnippet: "Download GitHub release assets",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
      tag: Type.Optional(
        Type.String({ description: "Release tag (defaults to the latest release)" }),
      ),
      pattern: Type.Optional(
        Type.String({
          description:
            'Comma-separated glob patterns for asset names, e.g. "*.tar.gz,*.deb" (default: every asset)',
        }),
      ),
      archive: Type.Optional(
        Type.Union([Type.Literal("zip"), Type.Literal("tar.gz")], {
          description: "Download the release's source archive instead of its assets",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return downloadReleaseAssets({ params, ctx, signal });
    },
  });

  // ── wait-github-pr-checks ─────────────────────────────────────────────────
  pi.registerTool({
    name: "wait-github-pr-checks",
    label: "Watch GitHub PR Checks",
    description:
      "Watch CI status checks for a PR until they complete. Blocks until all checks pass (or are skipped) or one fails. " +
      "Covers both commit statuses (Azure DevOps, Jenkins, ...) and GitHub Actions check runs. " +
      "Each polling round streams a compact bullet list of the checks still in flight via onUpdate; " +
      "on timeout the still-in-flight snapshot is returned instead of a verdict. " +
      "Use this when you need to wait for CI to complete and see the final result.",
    promptSnippet: "Watch and wait for GitHub PR CI checks to complete",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      fail_fast: Type.Optional(
        Type.Boolean({ description: "Exit immediately when any check fails (default: false)" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return client.waitPrChecks({ params, ctx, signal, onUpdate });
    },
  });

  // ── wait-github-commit-checks ──────────────────────────────────────────────
  pi.registerTool({
    name: "wait-github-commit-checks",
    label: "Watch GitHub Commit Checks",
    description:
      "Watch CI status checks for a commit until they complete — no pull request required. " +
      "Same semantics as wait-github-pr-checks: returns when any check fails (immediately under fail_fast) " +
      "or all checks pass/skip; on timeout the still-in-flight snapshot is returned. " +
      "With `event`, only check runs triggered by that workflow event (e.g. push) are judged; " +
      "commit statuses have an unknown trigger event and are excluded under a filter. " +
      "Use this to wait for the runs a commit's push triggered, or for checks on an arbitrary ref.",
    promptSnippet: "Watch and wait for GitHub commit CI checks to complete",
    parameters: Type.Object({
      commit: Type.Union([Type.Number(), Type.String()], {
        description:
          "Commit to wait for: full or partial SHA, branch name, or tag name (resolved to the commit's SHA)",
      }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      event: Type.Optional(
        Type.String({
          description:
            "Only judge check runs triggered by this workflow event (e.g. push, pull_request)",
        }),
      ),
      fail_fast: Type.Optional(
        Type.Boolean({ description: "Exit immediately when any check fails (default: false)" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return client.waitCommitChecks({ params, ctx, signal, onUpdate });
    },
  });

  // ── watch-github-run ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "watch-github-run",
    label: "Watch GitHub Workflow Run",
    description:
      "Watch a GitHub Actions workflow run until it completes. " +
      "Blocks until the run finishes and shows the final status.",
    promptSnippet: "Watch and wait for a GitHub Actions run to complete",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const { run_id, repo } = params;

      const pendant = subtitlePendant(params, "run_id");
      onUpdate?.({
        content: [{ type: "text", text: `Watching workflow run ${run_id}...` }],
        details: {},
      });

      const result = await runGh(["run", "watch", String(run_id), ...repoArgs(repo)], {
        cwd: ctx.cwd,
        signal,
        timeout: 600_000,
      });

      if (result.code !== 0) {
        throw new Error(`gh run watch failed: ${result.stderr || `exit code ${result.code}`}`);
      }

      return {
        content: [
          { type: "text", text: `## Workflow Run ${run_id} Completed\n\n${result.stdout}` },
        ],
        details: { exitCode: 0, input: params, ...(pendant && { pendant }) },
      };
    },
  });
}
