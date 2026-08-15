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
 *   - read-github-workflow-jobs: Get workflow run jobs
 *   - read-github-repo: Get repo info
 *   - list-github-releases: List releases
 *   - read-github-release: Get release details
 *   - wait-github-pr-checks: Watch PR CI checks
 *   - watch-github-run: Watch a workflow run
 *
 * Install:
 *   cp gh-readonly.ts ~/.pi/agent/extensions/
 *
 * Or for project-local:
 *   cp gh-readonly.ts .pi/extensions/
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

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
  ctx: { cwd?: string; signal?: AbortSignal; timeout?: number },
): Promise<GhResult> {
  return new Promise((resolve) => {
    const proc = spawn("gh", args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_PAGER: "cat" },
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

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      combined.push(text);
    });
    proc.stderr?.on("data", (data: Buffer) => {
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

// ── runtime validation schemas for JSON.parse results ───────────────────────

const repoViewSchema = Type.Object({ nameWithOwner: Type.String() });

const stepSchema = Type.Object({
  name: Type.String(),
  number: Type.Number(),
  status: Type.String(),
  conclusion: Type.Union([Type.String(), Type.Null()]),
});

const jobRunSchema = Type.Object({
  id: Type.Number(),
  name: Type.String(),
  status: Type.String(),
  conclusion: Type.Union([Type.String(), Type.Null()]),
  html_url: Type.Optional(Type.String()),
  steps: Type.Array(stepSchema),
});

const jobsResponseSchema = Type.Object({ jobs: Type.Array(jobRunSchema) });

const prHeadSchema = Type.Object({ headRefOid: Type.String() });

const workflowRunSchema = Type.Object({
  id: Type.Number(),
  name: Type.String(),
  html_url: Type.String(),
});

const workflowRunsSchema = Type.Object({ workflow_runs: Type.Array(workflowRunSchema) });

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

interface ListFilters {
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
 * List or search issues/PRs with structured filters.
 *
 * `gh issue list` / `gh pr list` are used when a repo is available (repo param or
 * current directory), with keywords passed via `--search`. When no repo is given
 * and keywords are present, falls back to `gh search issues` / `gh search prs`
 * with plain keywords — never embedding a `repo:` qualifier in the query string,
 * because `gh` mis-parses `repo:` values followed by spaces.
 */
async function listGithub(
  kind: "issue" | "pr",
  params: ListFilters,
  ctx: { cwd?: string; signal?: AbortSignal; input?: unknown },
): Promise<string> {
  const { repo, keywords, state, label, author, assignee, milestone, limit } = params;

  if (!repo && keywords) {
    const args = ["search", kind === "issue" ? "issues" : "prs", keywords];
    if (state && state !== "all") args.push("--state", state);
    if (label) args.push("--label", label);
    if (author) args.push("--author", author);
    if (assignee) args.push("--assignee", assignee);
    if (milestone) args.push("--milestone", milestone);
    if (limit) args.push("--limit", String(limit));
    return ghExec(args, ctx);
  }

  const args = [kind, "list", ...repoArgs(repo)];
  if (state) args.push("--state", state);
  if (keywords) args.push("--search", keywords);
  if (label) args.push("--label", label);
  if (author) args.push("--author", author);
  if (assignee) args.push("--assignee", assignee);
  if (milestone) args.push("--milestone", milestone);
  if (limit) args.push("--limit", String(limit));
  return ghExec(args, ctx);
}

// ── CI helpers ───────────────────────────────────────────────────────────────

export interface StepInfo {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
}

export interface JobInfo {
  id: number;
  name: string;
  conclusion: string | null;
  steps: StepInfo[];
}

/** Build GitHub-UI-style step list for details, marking expanded steps. */
export function stepsDetail(
  job: JobInfo,
  expandedSteps?: Set<number>,
): { number: number; name: string; conclusion: string | null; expanded?: boolean }[] {
  return job.steps.map((s) => ({
    number: s.number,
    name: s.name,
    conclusion: s.conclusion,
    ...(expandedSteps?.has(s.number) && { expanded: true }),
  }));
}

/** In-flight dedup map to avoid concurrent fetches of the same log. */
const inflightLogs = new Map<string, Promise<string>>();

async function getJobLog(
  runId: string,
  jobId: number,
  effectiveRepo: string,
  signal: AbortSignal | undefined,
  cwd: string | undefined,
  input?: unknown,
): Promise<string> {
  const cacheDir = join(homedir(), ".cache", "pi", "ci-logs", runId);
  const cacheFile = join(cacheDir, `${jobId}.log`);
  const key = `${runId}:${jobId}`;

  // Check in-flight dedup map
  const inflight = inflightLogs.get(key);
  if (inflight) return inflight;

  const fetchAndCache = async (): Promise<string> => {
    // Check file cache
    try {
      return await readFile(cacheFile, "utf8");
    } catch {
      // Not cached, fetch from GitHub
    }

    // `gh api` refuses to print responses that contain terminal escape
    // sequences unless `--allow-escape-sequences` is passed. Job logs are a
    // binary zip, so without this flag the download always fails with
    // "the response contains terminal escape sequences; pass
    // --allow-escape-sequences to output it anyway". The ANSI escapes are
    // stripped later by `cleanStepOutput`, so there is no injection surface.
    const log = await ghExec(
      ["api", "--allow-escape-sequences", `/repos/${effectiveRepo}/actions/jobs/${jobId}/logs`],
      {
        cwd,
        signal,
        input,
      },
    );

    // Write to cache
    await mkdir(cacheDir, { recursive: true });
    await withFileMutationQueue(cacheFile, async () => {
      await writeFile(cacheFile, log);
    });

    return log;
  };

  const promise = fetchAndCache();
  inflightLogs.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightLogs.delete(key);
  }
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

/**
 * Extract step content from raw job log by matching step names to "Run " groups.
 *
 * Each top-level step emits a `##[group]Run <name>` / `##[group]Post Run <name>`
 * marker at depth 1. Composite actions emit their internal steps as *additional*
 * depth-1 groups *after* the composite's own `##[endgroup]` (e.g. the internal
 * `Run actions/setup-python@…` groups inside `Run pypa/cibuildwheel@…`), so the
 * log's "Run " groups are NOT one-per-step.
 *
 * To handle that we treat a group as an *anchor* only when its action name
 * (after stripping the "Run "/"Post Run " prefix) matches a top-level API step
 * name. Composite-action internals match no API step and are absorbed into the
 * span of the enclosing step instead of truncating it.
 *
 * Step 1 ("Set up job") maps to everything before the first anchor group.
 * Steps with an anchor map to the span from their anchor to the next anchor.
 * Explicitly named steps that lack a "Run " prefix (e.g. a step named
 * "Setup node" running actions/setup-node) are located between the previous
 * and next anchor's groups.
 * Steps that were skipped and never executed return null.
 *
 * Returns null if no matching group is found.
 */
export function extractStepFromLog(
  log: string,
  stepNumber: number,
  apiSteps: { number: number; name: string }[],
): string | null {
  if (apiSteps.every((s) => s.number !== stepNumber)) return null;

  const lines = log.split("\n");

  // Collect depth-1 "Run "/"Post Run " groups in log order.
  const groups: { line: number; action: string }[] = [];
  let depth = 0;
  for (const [i, line] of lines.entries()) {
    if (line.includes("##[endgroup]")) {
      if (depth > 0) depth--;
      continue;
    }
    if (line.includes("##[group]")) {
      depth++;
      if (depth === 1) {
        const m = /##\[group\](.*)/.exec(line);
        const name = m ? m[1].trim() : "";
        if (name.startsWith("Run ") || name.startsWith("Post Run ")) {
          groups.push({ line: i, action: name.replace(/^(Run |Post Run )/, "").trim() });
        }
      }
    }
  }

  // Step 1 ("Set up job"): everything before the first "Run "/"Post Run " group.
  if (stepNumber === 1) {
    return lines
      .slice(0, groups[0]?.line ?? lines.length)
      .join("\n")
      .trimEnd();
  }

  // API steps that produce a "Run "/"Post Run " log group, in step order.
  const runSteps = apiSteps
    .filter((s) => /^(Run |Post Run )/.test(s.name))
    .map((s) => ({ number: s.number, action: s.name.replace(/^(Run |Post Run )/, "").trim() }))
    .toSorted((a, b) => a.number - b.number);

  // Greedily assign each run step the first unclaimed group whose action name
  // matches (log order). Leftover groups are composite-action internals.
  const used = new Set<number>();
  const stepToGroup = new Map<number, number>(); // api step number -> group index
  for (const rs of runSteps) {
    const gi = groups.findIndex((g, idx) => !used.has(idx) && g.action === rs.action);
    if (gi !== -1) {
      used.add(gi);
      stepToGroup.set(rs.number, gi);
    }
  }

  // Anchor sequence in log order.
  const anchors = [...stepToGroup]
    .map(([stepNum, gi]) => ({ stepNum, line: groups[gi].line }))
    .toSorted((a, b) => a.line - b.line);

  // Direct anchor hit: span from this anchor to the next one.
  const anchorIdx = anchors.findIndex((a) => a.stepNum === stepNumber);
  if (anchorIdx !== -1) {
    const start = anchors[anchorIdx].line;
    const end = anchorIdx + 1 < anchors.length ? anchors[anchorIdx + 1].line : lines.length;
    return lines.slice(start, end).join("\n").trimEnd();
  }

  // Non-anchor step (explicitly named, e.g. "Setup node"): its group sits in
  // the gap between the previous and next anchors' groups. Take the first
  // unclaimed group in that span.
  const prevAnchor = anchors.reduce<{ stepNum: number; line: number } | undefined>(
    (acc, a) => (a.stepNum < stepNumber ? a : acc),
    undefined,
  );
  const nextAnchor = anchors.find((a) => a.stepNum > stepNumber);

  const spanStart = prevAnchor ? prevAnchor.line + 1 : 0;
  const spanEnd = nextAnchor ? nextAnchor.line : lines.length;

  for (const [gi, g] of groups.entries()) {
    if (used.has(gi)) continue;
    if (g.line >= spanStart && g.line < spanEnd) {
      return lines.slice(g.line, spanEnd).join("\n").trimEnd();
    }
  }

  return null;
}

// ── ci-logs rendering (pure, testable) ──────────────────────────────────────

export interface CiLogsJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: StepInfo[];
}

export interface CiLogsResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

/** GitHub Actions runner line prefix: `2026-08-05T16:35:50.8358826Z `. */
const RUNNER_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;
/** ANSI color escape sequences. */
// eslint-disable-next-line no-control-regex -- intentional: matching raw ESC sequences in runner logs
const ANSI_RE = /\u001B\[[0-9;]*m/g;

/**
 * Strip the runner framing from a step's raw log, leaving the command's own
 * output as plain text: removes the per-line timestamp prefix, ANSI color
 * escapes and `##[group]` / `##[endgroup]` marker lines. `##[error]` /
 * `##[warning]` lines are kept — their message is part of the output.
 */
export function cleanStepOutput(stepLog: string): string {
  return stepLog
    .split("\n")
    .map((line) =>
      line
        .replace(/^\uFEFF/, "") // UTF-8 BOM on the first line
        .replace(RUNNER_TIMESTAMP_RE, "")
        .replaceAll(ANSI_RE, "")
        .replace(/\r$/, "")
        .trimEnd(),
    )
    .filter((line) => !line.startsWith("##[group]") && !line.startsWith("##[endgroup]"))
    .join("\n")
    .trim();
}

/**
 * Strip terminal escape sequences and a leading UTF-8 BOM from a raw job log,
 * keeping everything else — timestamps, `##[group]` markers, blank lines —
 * intact. Used when writing a job's complete log to a file: complete, but
 * readable without ANSI garbage.
 */
export function stripAnsi(text: string): string {
  return text.replace(/^\uFEFF/, "").replaceAll(ANSI_RE, "");
}

export interface StepLogParams {
  runId: string;
  job?: string;
  step: string;
  offset?: number;
  limit?: number;
  /** Return the complete, untruncated step output (ignores `offset`/`limit`). */
  full?: boolean;
}

/**
 * Render the result of `read-github-ci-logs` for a single step: the step's
 * complete log as plain text (no runner framing). `job` is required — a step
 * only exists inside a specific job. `offset`/`limit` control the returned
 * text. Pure — no network, no `gh`.
 */
export async function renderStepLog(
  params: StepLogParams,
  jobs: CiLogsJob[],
  fetchJobLog: (jobId: number) => Promise<string>,
  onUpdate?: (msg: CiLogsResult) => void,
): Promise<CiLogsResult> {
  const { job, step, offset, limit, full } = params;

  if (!job) {
    return {
      content: [{ type: "text", text: "`job` is required when fetching a step's logs." }],
      details: {},
    };
  }

  const isNumeric = /^\d+$/.test(job);
  const targetJob = jobs.find((j) => (isNumeric ? String(j.id) : j.name) === job);
  if (!targetJob) {
    return {
      content: [
        {
          type: "text",
          text: `Job "${job}" not found. Available: ${jobs.map((j) => `${j.name} (id: ${j.id})`).join(", ")}`,
        },
      ],
      details: {},
    };
  }

  if (targetJob.status === "queued") {
    return {
      content: [
        {
          type: "text",
          text: `Job "${targetJob.name}" is still queued — no logs available yet. Use \`watch-github-run\` to wait for it to start, then retry.`,
        },
      ],
      details: {},
    };
  }

  // Resolve step name → number
  const found = targetJob.steps.find((s) => s.name.toLowerCase() === step.toLowerCase());
  if (!found) {
    return {
      content: [
        {
          type: "text",
          text: `Step "${step}" not found. Available: ${targetJob.steps.map((s) => `${s.name} (${s.number})`).join(", ")}`,
        },
      ],
      details: {},
    };
  }
  const stepNum = found.number;

  if (stepNum < 1 || stepNum > targetJob.steps.length) {
    return {
      content: [
        {
          type: "text",
          text: `Step ${stepNum} out of range. Job "${targetJob.name}" has ${targetJob.steps.length} steps (1-${targetJob.steps.length}).`,
        },
      ],
      details: {},
    };
  }

  onUpdate?.({
    content: [{ type: "text", text: `Fetching logs for step ${stepNum}...` }],
    details: {},
  });

  const rawLog = await fetchJobLog(targetJob.id);

  const stepLog = extractStepFromLog(rawLog, stepNum, targetJob.steps);
  if (stepLog === null) {
    return {
      content: [
        {
          type: "text",
          text: `Could not extract step ${stepNum} from job "${targetJob.name}" logs. The log may be malformed or empty. Try fetching without \`step\` to see the full job log.`,
        },
      ],
      details: {},
    };
  }

  const clean = cleanStepOutput(stepLog);

  // `full`: return the complete output, no truncation and no offset.
  if (full) {
    const fullLines = clean.split("\n").length;
    return {
      content: [{ type: "text", text: clean }],
      details: {
        summary: `Step ${stepNum} — ${targetJob.name} / ${found.name}: complete output (${fullLines} lines)`,
        truncated: false,
        full: true,
        job: {
          name: targetJob.name,
          conclusion: targetJob.conclusion,
          steps: stepsDetail(targetJob, new Set([stepNum])),
        },
        totalLines: fullLines,
        shownLines: fullLines,
      },
    };
  }

  // Apply offset on the cleaned text, then truncate.
  const totalLines = clean.split("\n").length;
  let logToShow = clean;
  let appliedOffset = false;
  if (offset !== undefined && offset !== null && offset > 1) {
    if (offset > totalLines) {
      return {
        content: [
          {
            type: "text",
            text: `Offset ${offset} exceeds step log length (${totalLines} lines).`,
          },
        ],
        details: {},
      };
    }
    logToShow = clean
      .split("\n")
      .slice(offset - 1)
      .join("\n");
    appliedOffset = true;
  }

  const maxLines = limit ?? 500;
  const maxBytes = 60 * 1024;
  const { text, truncated: tr } = truncate(logToShow, maxLines, maxBytes);
  const shownLines = text.split("\n").length;

  return {
    content: [{ type: "text", text }],
    details: {
      summary: `Step ${stepNum} — ${targetJob.name} / ${found.name}: ${shownLines} of ${totalLines} lines${tr ? " (truncated)" : ""}`,
      truncated: tr,
      job: {
        name: targetJob.name,
        conclusion: targetJob.conclusion,
        steps: stepsDetail(targetJob, new Set([stepNum])),
      },
      totalLines,
      shownLines,
      offset: appliedOffset ? offset : undefined,
    },
  };
}

export interface JobLogsParams {
  runId: string;
  job?: string;
  offset?: number;
  limit?: number;
  /** Expand every step's complete output (default: only failed steps, truncated). */
  full?: boolean;
}

export interface JobLogsStep {
  name: string;
  output?: string;
}

export interface JobLogsOutput {
  name: string;
  steps: JobLogsStep[];
}

/**
 * Render the result of `read-github-ci-logs` without a `step`: a JSON array of
 * jobs `[{ name, steps: [{ name, output? }] }]`. Every step is listed by name;
 * only failed steps carry an `output` (their log as plain text). `job` is an
 * optional filter; `offset`/`limit` control the size of each `output` text.
 * Pure — no network, no `gh`.
 */
export async function renderJobLogs(
  params: JobLogsParams,
  jobs: CiLogsJob[],
  fetchJobLog: (jobId: number) => Promise<string>,
): Promise<CiLogsResult> {
  const { job, offset, limit, full } = params;

  if (!jobs || jobs.length === 0) {
    return {
      content: [{ type: "text", text: `No jobs found for run ${params.runId}` }],
      details: {},
    };
  }

  let targetJobs = jobs;
  if (job) {
    const isNumeric = /^\d+$/.test(job);
    targetJobs = jobs.filter((j) => (isNumeric ? String(j.id) : j.name) === job);
    if (targetJobs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Job "${job}" not found. Available: ${jobs.map((j) => `${j.name} (id: ${j.id})`).join(", ")}`,
          },
        ],
        details: {},
      };
    }
  }

  const output: JobLogsOutput[] = [];

  for (const j of targetJobs) {
    const steps: JobLogsStep[] = [];
    let rawLog: string | null = null;

    for (const s of j.steps) {
      if (!full && s.conclusion !== "failure") {
        steps.push({ name: s.name });
        continue;
      }

      try {
        rawLog ??= await fetchJobLog(j.id);
        const stepLog = extractStepFromLog(rawLog, s.number, j.steps);
        if (!stepLog) {
          steps.push({ name: s.name });
          continue;
        }

        const clean = cleanStepOutput(stepLog);

        // `full`: every step carries its complete, untruncated output.
        if (full) {
          steps.push({ name: s.name, output: clean });
          continue;
        }

        const totalLines = clean.split("\n").length;

        // Apply offset on the cleaned text, then truncate.
        let logToShow = clean;
        if (offset !== undefined && offset !== null && offset > 1) {
          if (offset > totalLines) {
            steps.push({ name: s.name });
            continue;
          }
          logToShow = clean
            .split("\n")
            .slice(offset - 1)
            .join("\n");
        }

        const { text } = truncate(logToShow, limit ?? 500, 60 * 1024);
        steps.push({ name: s.name, ...(text && { output: text }) });
      } catch {
        // Log fetch failed — list the step without an output.
        steps.push({ name: s.name });
      }
    }

    output.push({ name: j.name, steps });
  }

  const totalJobs = output.length;
  const failedJobs = output.filter((j) => j.steps.some((s) => s.output !== undefined)).length;
  const expandedSteps = output.reduce(
    (acc, j) => acc + j.steps.filter((s) => s.output !== undefined).length,
    0,
  );

  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    details: {
      summary: full
        ? `${totalJobs} job${totalJobs > 1 ? "s" : ""}, ${expandedSteps} step output${expandedSteps === 1 ? "" : "s"} expanded (full, untruncated)`
        : `${totalJobs} job${totalJobs > 1 ? "s" : ""}, ${failedJobs} failed, ${expandedSteps} failed step${expandedSteps > 1 ? "s" : ""}`,
      truncated: undefined,
      ...(full && { full: true }),
      jobs: targetJobs.map((j) => ({
        name: j.name,
        conclusion: j.conclusion,
        steps: stepsDetail(j, undefined),
      })),
    },
  };
}

// ── writing complete logs to a file ─────────────────────────────────────────

export interface WriteLogFileParams {
  runId: string;
  job?: string;
  step?: string;
  outputFile: string;
}

/**
 * Write the complete log to a file and return metadata (path, line/byte
 * counts) instead of the log content itself. With `step`: the step's cleaned
 * output. Without `step`: the whole job's log, timestamps and `##[group]`
 * markers kept but ANSI escapes stripped. `job` is required when the run has
 * more than one job (a single-job run is used implicitly). Relative
 * `outputFile` paths resolve against `cwd`.
 */
export async function writeLogFile(
  params: WriteLogFileParams,
  jobs: CiLogsJob[],
  fetchJobLog: (jobId: number) => Promise<string>,
  cwd: string | undefined,
  input: unknown,
): Promise<CiLogsResult> {
  const { job, step, outputFile } = params;

  const isNumeric = /^\d+$/.test(job ?? "");
  const targetJobs = job ? jobs.filter((j) => (isNumeric ? String(j.id) : j.name) === job) : jobs;
  if (targetJobs.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `Job "${job}" not found. Available: ${jobs.map((j) => `${j.name} (id: ${j.id})`).join(", ")}`,
        },
      ],
      details: { input },
    };
  }
  if (targetJobs.length > 1) {
    return {
      content: [
        {
          type: "text",
          text: `Job "${job}" matches ${targetJobs.length} jobs. Specify a unique job name or id. Available: ${jobs.map((j) => `${j.name} (id: ${j.id})`).join(", ")}`,
        },
      ],
      details: { input },
    };
  }
  const targetJob = targetJobs[0];

  if (targetJob.status === "queued") {
    return {
      content: [
        {
          type: "text",
          text: `Job "${targetJob.name}" is still queued — no logs available yet. Use \`watch-github-run\` to wait for it to start, then retry.`,
        },
      ],
      details: { input },
    };
  }

  const rawLog = await fetchJobLog(targetJob.id);

  let content: string;
  let what: string;
  if (step !== undefined && step !== null) {
    const found = targetJob.steps.find((s) => s.name.toLowerCase() === step.toLowerCase());
    if (!found) {
      return {
        content: [
          {
            type: "text",
            text: `Step "${step}" not found. Available: ${targetJob.steps.map((s) => `${s.name} (${s.number})`).join(", ")}`,
          },
        ],
        details: { input },
      };
    }
    const stepLog = extractStepFromLog(rawLog, found.number, targetJob.steps);
    if (stepLog === null) {
      return {
        content: [
          {
            type: "text",
            text: `Could not extract step ${found.number} from job "${targetJob.name}" logs. The log may be malformed or empty.`,
          },
        ],
        details: { input },
      };
    }
    content = cleanStepOutput(stepLog);
    what = `step ${found.number} ("${found.name}") of job "${targetJob.name}"`;
  } else {
    content = stripAnsi(rawLog);
    what = `job "${targetJob.name}" (id: ${targetJob.id})`;
  }

  const target = resolve(cwd ?? process.cwd(), outputFile);
  await mkdir(dirname(target), { recursive: true });
  await withFileMutationQueue(target, async () => {
    await writeFile(target, content);
  });

  const lines = content.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf8");

  return {
    content: [
      {
        type: "text",
        text:
          `## CI log written to \`${target}\`\n\n` +
          `- content: ${what}\n` +
          `- ${lines} lines, ${bytes} bytes\n` +
          `- run: ${params.runId}\n\n` +
          `Read it with the \`read\` tool (use \`offset\`/\`limit\` for large files).`,
      },
    ],
    details: {
      outputFile: target,
      lines,
      bytes,
      runId: params.runId,
      job: {
        name: targetJob.name,
        id: targetJob.id,
        conclusion: targetJob.conclusion,
      },
      input,
    },
  };
}

// ── tools ────────────────────────────────────────────────────────────────────

export default function ghReadonlyTools(pi: ExtensionAPI) {
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
      return toToolResult(
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
    },
  });

  // ── list-github-issues ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "list-github-issues",
    label: "GitHub Issues List",
    description:
      "List GitHub issues with optional filters and keyword search. When repo is omitted, searches across GitHub using keywords.",
    promptSnippet: "List or search GitHub issues",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
      keywords: Type.Optional(Type.String({ description: "Search keywords (free text)" })),
      state: Type.Optional(Type.String({ description: "open, closed, all (default: open)" })),
      label: Type.Optional(Type.String({ description: "Filter by label" })),
      author: Type.Optional(Type.String({ description: "Filter by author" })),
      assignee: Type.Optional(Type.String({ description: "Filter by assignee" })),
      milestone: Type.Optional(Type.String({ description: "Filter by milestone" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 30)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toToolResult(
        await listGithub("issue", params, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
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
      return toToolResult(
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
    },
  });

  // ── list-github-prs ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "list-github-prs",
    label: "GitHub PRs List",
    description:
      "List GitHub pull requests with optional filters and keyword search. When repo is omitted, searches across GitHub using keywords.",
    promptSnippet: "List or search GitHub PRs",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
      keywords: Type.Optional(Type.String({ description: "Search keywords (free text)" })),
      state: Type.Optional(
        Type.String({ description: "open, closed, merged, all (default: open)" }),
      ),
      label: Type.Optional(Type.String({ description: "Filter by label" })),
      author: Type.Optional(Type.String({ description: "Filter by author" })),
      assignee: Type.Optional(Type.String({ description: "Filter by assignee" })),
      milestone: Type.Optional(Type.String({ description: "Filter by milestone" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 30)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toToolResult(
        await listGithub("pr", params, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
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
      return toToolResult(await ghExec(args, { cwd: ctx.cwd, signal, input: params }), params);
    },
  });

  // ── read-github-pr-status ──────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-pr-status",
    label: "GitHub PR Status",
    description:
      "Get the current status checks and CI results for a GitHub pull request. Returns the current snapshot immediately; pending checks are reported as-is, not waited on. Use wait-github-pr-checks to block until checks finish.",
    promptSnippet: "Read GitHub PR status checks",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const args = ["pr", "checks", String(number), ...repoArgs(repo)];

      // `gh pr checks` exit codes: 0 = all passed, 1 = some failed, 8 = some
      // pending. All three are valid states — return the current snapshot
      // as-is without waiting. `wait-github-pr-checks` is the blocking variant.
      const result = await runGh(args, { cwd: ctx.cwd, signal });

      if (result.code !== 0 && result.code !== 1 && result.code !== 8) {
        // Anything else is a real error (cancelled, auth, network, ...)
        throw new GhError(args, result, params);
      }
      return toToolResult(result.stdout, params);
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

        const [comments, reviewsOut] = await Promise.all([
          ghExec(["api", `/repos/${effectiveRepo}/pulls/${String(number)}/comments`], {
            cwd: ctx.cwd,
            signal,
            input: params,
          }),
          ghExec(["api", `/repos/${effectiveRepo}/pulls/${String(number)}/reviews`], {
            cwd: ctx.cwd,
            signal,
            input: params,
          }),
        ]);

        const reviewComments = Value.Parse(Type.Array(Type.Unknown()), JSON.parse(comments));
        const reviewSummaries = Value.Parse(Type.Array(Type.Unknown()), JSON.parse(reviewsOut));

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
      return {
        content: [{ type: "text", text }],
        details: { input: params, truncated },
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
      return toToolResult(
        await ghExec(["issue", "view", String(number), ...repoArgs(repo), "--json", "comments"], {
          cwd: ctx.cwd,
          signal,
          input: params,
        }),
        params,
      );
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
      return toToolResult(await ghExec(args, { cwd: ctx.cwd, signal, input: params }), params);
    },
  });

  // ── read-github-ci-logs ────────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-ci-logs",
    label: "GitHub CI Logs",
    description:
      "Get CI logs from a GitHub Actions workflow run. Without step: returns a JSON array of jobs [{name, steps:[{name, output?}]}] where every step is listed by name and failed steps carry their log as plain text in `output`. With step (requires job): returns that step's complete log as plain text. offset/limit control the size of every expanded output. Use run_id from list-github-workflow-runs. Note: queued jobs have no logs yet; use watch-github-run to wait for completion. Set full=true for complete untruncated outputs (every step when step is omitted; caution: very large outputs consume a lot of LLM context). Set output_file=/path to write the complete log to a file instead of returning it (requires job when the run has multiple jobs); the tool returns the file path to read.",
    promptSnippet: "Read GitHub CI logs",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      job: Type.Optional(
        Type.String({
          description:
            "Job name or ID. Optional filter when listing jobs; required when fetching a specific step's logs.",
        }),
      ),
      step: Type.Optional(
        Type.String({
          description:
            "Step name to fetch the complete log for. Requires `job`. Omit to list jobs/steps with failed step logs expanded.",
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description:
            "Line number to start each output text from (1-indexed). Useful for long outputs where the error is at the end.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of lines per output text (default 500).",
        }),
      ),
      full: Type.Optional(
        Type.Boolean({
          description:
            "Return complete, untruncated output instead of the default 500-line/60KB cap. With `step`: that step's full output. Without `step`: every step's full output (not just failed ones). Ignored when `output_file` is set. Caution: very large outputs consume a lot of LLM context — prefer `output_file` for big logs.",
        }),
      ),
      output_file: Type.Optional(
        Type.String({
          description:
            "Write the complete log to this file instead of returning it (relative paths resolve against the working directory). With `step` (requires `job`): the step's cleaned output. Without `step`: requires `job` (or a run with a single job) and writes that job's full log — timestamps and group markers kept, ANSI escapes stripped. Returns the file path; read it with the `read` tool.",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const { run_id, repo, job, step, offset, limit, full, output_file } = params;

      const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
      const jobsOut = await ghExec(["api", `/repos/${effectiveRepo}/actions/runs/${run_id}/jobs`], {
        cwd: ctx.cwd,
        signal,
        input: params,
      });
      const { jobs } = Value.Parse(jobsResponseSchema, JSON.parse(jobsOut));

      const fetchJobLog = (jobId: number): Promise<string> =>
        getJobLog(String(run_id), jobId, effectiveRepo, signal, ctx.cwd, params);

      // ── Write the complete log to a file ───────────────────────────────
      if (output_file !== undefined && output_file !== null && output_file !== "") {
        return writeLogFile(
          { runId: String(run_id), job, step, outputFile: output_file },
          jobs,
          fetchJobLog,
          ctx.cwd,
          params,
        );
      }

      // ── Fetch a specific step's logs (requires `job`) ─────────────────
      if (step !== undefined && step !== null) {
        onUpdate?.({
          content: [{ type: "text", text: `Fetching job list...` }],
          details: {},
        });
        const stepResult = await renderStepLog(
          { runId: String(run_id), job, step, offset, limit, full },
          jobs,
          fetchJobLog,
          onUpdate,
        );
        return { ...stepResult, details: { ...stepResult.details, input: params } };
      }

      // ── List jobs/steps, with failed step logs expanded ────────────────
      onUpdate?.({
        content: [{ type: "text", text: `Fetching job list...` }],
        details: {},
      });
      const jobsResult = await renderJobLogs(
        { runId: String(run_id), job, offset, limit, full },
        jobs,
        fetchJobLog,
      );
      return { ...jobsResult, details: { ...jobsResult.details, input: params } };
    },
  });

  // ── read-github-workflow-jobs ──────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-workflow-jobs",
    label: "GitHub Workflow Jobs",
    description:
      "Get structured job data (name, status, conclusion, job ID) for a workflow run. Useful before reading CI logs to identify which job to inspect.",
    promptSnippet: "Read GitHub workflow run jobs",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { run_id, repo } = params;
      const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
      return toToolResult(
        await ghExec(["api", `/repos/${effectiveRepo}/actions/runs/${run_id}/jobs`], {
          cwd: ctx.cwd,
          signal,
          input: params,
        }),
        params,
      );
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
      return toToolResult(await ghExec(args, { cwd: ctx.cwd, signal, input: params }), params);
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
      return toToolResult(await ghExec(args, { cwd: ctx.cwd, signal, input: params }), params);
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
      return toToolResult(
        await ghExec(["release", "view", tag, ...repoArgs(repo)], {
          cwd: ctx.cwd,
          signal,
          input: params,
        }),
        params,
      );
    },
  });

  // ── wait-github-pr-checks ─────────────────────────────────────────────────
  pi.registerTool({
    name: "wait-github-pr-checks",
    label: "Watch GitHub PR Checks",
    description:
      "Watch CI status checks for a PR until they complete. Blocks until all checks finish or one fails. " +
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
      const { number, repo, fail_fast } = params;

      onUpdate?.({
        content: [{ type: "text", text: `Watching CI checks for PR #${number}...` }],
        details: {},
      });

      const args = ["pr", "checks", String(number), ...repoArgs(repo), "--watch"];
      if (fail_fast) args.push("--fail-fast");

      // gh 的退出码语义不可靠：checks 失败时返回 exit 1（SilentError），挂起时
      // 返回 exit 8（PendingError），且失败详情只在非结构化的 stdout 表格里。
      // 因此 watch 退出后直接用 Actions API 抓取该 PR head 提交关联的所有
      // workflow job，以 job 的真实 conclusion 为准判断成功/失败。
      const result = await runGh(args, { cwd: ctx.cwd, signal, timeout: 600_000 });
      if (result.killed) {
        throw new Error(
          result.reason === "timeout"
            ? "gh pr checks --watch timed out after 10 minutes"
            : "gh pr checks --watch was aborted",
        );
      }

      const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
      const prOut = await ghExec(
        ["pr", "view", String(number), "--repo", effectiveRepo, "--json", "headRefOid"],
        { cwd: ctx.cwd, signal, input: params },
      );
      const { headRefOid } = Value.Parse(prHeadSchema, JSON.parse(prOut));

      onUpdate?.({
        content: [{ type: "text", text: `Fetching workflow jobs for PR #${number}...` }],
        details: {},
      });

      const runsOut = await ghExec(
        ["api", `/repos/${effectiveRepo}/actions/runs?head_sha=${headRefOid}&per_page=100`],
        { cwd: ctx.cwd, signal, input: params },
      );
      const { workflow_runs } = Value.Parse(workflowRunsSchema, JSON.parse(runsOut));

      const failedJobs: {
        runId: number;
        runName: string;
        runUrl: string;
        jobId: number;
        jobName: string;
        conclusion: string;
        jobUrl?: string;
      }[] = [];
      let totalJobs = 0;

      for (const run of workflow_runs) {
        const jobsOut = await ghExec(
          ["api", `/repos/${effectiveRepo}/actions/runs/${run.id}/jobs?per_page=100`],
          { cwd: ctx.cwd, signal, input: params },
        );
        const { jobs } = Value.Parse(jobsResponseSchema, JSON.parse(jobsOut));
        totalJobs += jobs.length;

        for (const job of jobs) {
          if (!job.conclusion || FAILED_JOB_CONCLUSIONS.has(job.conclusion)) {
            failedJobs.push({
              runId: run.id,
              runName: run.name,
              runUrl: run.html_url,
              jobId: job.id,
              jobName: job.name,
              conclusion: job.conclusion ?? "in_progress",
              jobUrl: job.html_url,
            });
          }
        }
      }

      if (totalJobs === 0) {
        return {
          content: [
            {
              type: "text",
              text: `## PR #${number} CI Checks\n\nNo workflow runs found for head commit ${headRefOid.slice(0, 7)}.`,
            },
          ],
          details: { status: "no-jobs", totalJobs: 0, input: params },
        };
      }

      if (failedJobs.length > 0) {
        const lines = failedJobs.map(
          (j) =>
            `- ${statusIcon(j.conclusion)} **${j.jobName}** (${j.conclusion}) — [job #${j.jobId}](${j.jobUrl ?? j.runUrl})\n` +
            `  - workflow: [${j.runName} (#${j.runId})](${j.runUrl})`,
        );
        return {
          content: [
            {
              type: "text",
              text:
                `## PR #${number} CI Checks - FAILED\n\n` +
                `${failedJobs.length} of ${totalJobs} job(s) did not succeed:\n\n${lines.join("\n")}`,
            },
          ],
          details: {
            status: "failure",
            totalJobs,
            failedJobs,
            input: params,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `## PR #${number} CI Checks - PASSED\n\nAll ${totalJobs} job(s) succeeded.`,
          },
        ],
        details: { status: "success", totalJobs, input: params },
      };
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
        details: { exitCode: 0, input: params },
      };
    },
  });
}
