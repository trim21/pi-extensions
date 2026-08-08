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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  combined: string;
  /** Why the process was killed, when `killed` is true. */
  reason?: "timeout" | "abort";
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
      if (!killed) {
        killed = true;
        killReason = reason;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      }
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
      if (ctx.signal && onAbort) {
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

    proc.on("error", () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (ctx.signal && onAbort) {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      resolve({ stdout, stderr, code: 1, killed, combined: combined.join(""), reason: killReason });
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
    super(
      `${inputText}<output>${result.combined.trim() || `exit code ${result.code}`}${killedText}<output>`,
    );
    this.name = "GhError";
    this.args = args;
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.input = input;
  }
}

/** How long `read-github-pr-status` waits for pending checks to resolve. */
const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 30 * 60_000;

/** Sleep for `ms`, resolving early if `signal` is aborted. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll a `gh pr checks` query until it reaches a final state.
 *
 * `gh pr checks` exit codes: 0 = all passed, 1 = some failed, 8 = some pending.
 * Pending (8) is polled every `intervalMs` until `timeoutMs` elapses, at which
 * point the current result is returned as-is. Any other code is returned
 * immediately; the caller decides whether it is an error.
 */
export async function pollChecksResult<R extends { code: number; stdout: string }>(
  query: () => Promise<R>,
  opts: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {},
): Promise<R> {
  const { signal, intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) {
      throw new Error("read-github-pr-status aborted");
    }
    const result = await query();
    if (result.code !== 8) {
      // 0 = all passed, 1 = some failed, anything else is a real error
      return result;
    }
    // Still pending — keep waiting unless the overall timeout expired
    if (Date.now() >= deadline) {
      return result;
    }
    await sleep(intervalMs, signal);
  }
}

/** Run `gh` and return stdout. On non-zero exit, throws a `GhError` carrying the toolcall input and raw command. */
export async function ghExec(
  args: string[],
  ctx: { cwd?: string; signal?: AbortSignal; input?: unknown },
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
  steps: Type.Array(stepSchema),
});

const jobsResponseSchema = Type.Object({ jobs: Type.Array(jobRunSchema) });

function truncate(
  text: string,
  maxLines = 2000,
  maxBytes = 50 * 1024,
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { text, truncated: false };
  }

  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (out.length >= maxLines) break;
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
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
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const { text, truncated } = truncate(stdout);
  return {
    content: [{ type: "text", text }],
    details: { ...(input !== undefined ? { input } : {}), truncated },
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
): Array<{ number: number; name: string; conclusion: string | null; expanded?: boolean }> {
  return job.steps.map((s) => ({
    number: s.number,
    name: s.name,
    conclusion: s.conclusion,
    ...(expandedSteps?.has(s.number) ? { expanded: true } : {}),
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
      return await readFile(cacheFile, "utf-8");
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

export function statusIcon(conclusion: string | null): string {
  switch (conclusion) {
    case "success":
      return "✅";
    case "failure":
      return "❌";
    case "cancelled":
      return "🚫";
    case "skipped":
      return "⏭️";
    case "timed_out":
      return "⏰";
    case "action_required":
      return "⚠️";
    default:
      return "🔄";
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
  apiSteps: Array<{ number: number; name: string }>,
): string | null {
  const targetStep = apiSteps.find((s) => s.number === stepNumber);
  if (!targetStep) return null;

  const lines = log.split("\n");

  // Collect depth-1 "Run "/"Post Run " groups in log order.
  const groups: Array<{ line: number; action: string }> = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("##[endgroup]")) {
      if (depth > 0) depth--;
      continue;
    }
    if (line.includes("##[group]")) {
      depth++;
      if (depth === 1) {
        const m = line.match(/##\[group\](.*)/);
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
    .sort((a, b) => a.number - b.number);

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
  const anchors = [...stepToGroup.entries()]
    .map(([stepNum, gi]) => ({ stepNum, line: groups[gi].line }))
    .sort((a, b) => a.line - b.line);

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

  for (let gi = 0; gi < groups.length; gi++) {
    if (used.has(gi)) continue;
    const g = groups[gi];
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

export type CiLogsResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

/** GitHub Actions runner line prefix: `2026-08-05T16:35:50.8358826Z `. */
const RUNNER_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;
/** ANSI color escape sequences. */
const ANSI_RE = /\u001b\[[0-9;]*m/g;

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
        .replace(ANSI_RE, "")
        .replace(/\r$/, "")
        .trimEnd(),
    )
    .filter((line) => !line.startsWith("##[group]") && !line.startsWith("##[endgroup]"))
    .join("\n")
    .trim();
}

export interface StepLogParams {
  runId: string;
  job?: string;
  step: string;
  offset?: number;
  limit?: number;
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
  const { job, step, offset, limit } = params;

  if (!job) {
    return {
      content: [{ type: "text", text: "`job` is required when fetching a step's logs." }],
      details: {},
    };
  }

  const isNumeric = /^\d+$/.test(job);
  const targetJob = jobs.find((j) => (isNumeric ? String(j.id) === job : j.name === job));
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
  const { job, offset, limit } = params;

  if (!jobs || jobs.length === 0) {
    return {
      content: [{ type: "text", text: `No jobs found for run ${params.runId}` }],
      details: {},
    };
  }

  let targetJobs = jobs;
  if (job) {
    const isNumeric = /^\d+$/.test(job);
    targetJobs = jobs.filter((j) => (isNumeric ? String(j.id) === job : j.name === job));
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
      if (s.conclusion !== "failure") {
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
        steps.push({ name: s.name, ...(text ? { output: text } : {}) });
      } catch {
        // Log fetch failed — list the step without an output.
        steps.push({ name: s.name });
      }
    }

    output.push({ name: j.name, steps });
  }

  const totalJobs = output.length;
  const failedJobs = output.filter((j) => j.steps.some((s) => s.output !== undefined)).length;
  const totalFailedSteps = output.reduce(
    (acc, j) => acc + j.steps.filter((s) => s.output !== undefined).length,
    0,
  );

  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    details: {
      summary: `${totalJobs} job${totalJobs > 1 ? "s" : ""}, ${failedJobs} failed, ${totalFailedSteps} failed step${totalFailedSteps > 1 ? "s" : ""}`,
      truncated: undefined,
      jobs: targetJobs.map((j) => ({
        name: j.name,
        conclusion: j.conclusion,
        steps: stepsDetail(j, undefined),
      })),
    },
  };
}

// ── tools ────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
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
    description: "Get status checks and CI results for a GitHub pull request.",
    promptSnippet: "Read GitHub PR status checks",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const args = ["pr", "checks", String(number), ...repoArgs(repo)];

      // Pending is not an error — poll until checks fail or all pass.
      const final = await pollChecksResult(() => runGh(args, { cwd: ctx.cwd, signal }), {
        signal,
      });

      if (final.code !== 0 && final.code !== 1 && final.code !== 8) {
        // Anything else is a real error (cancelled, auth, network, ...)
        throw new GhError(args, final, params);
      }
      return toToolResult(final.stdout, params);
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
      "Get CI logs from a GitHub Actions workflow run. Without step: returns a JSON array of jobs [{name, steps:[{name, output?}]}] where every step is listed by name and failed steps carry their log as plain text in `output`. With step (requires job): returns that step's complete log as plain text. offset/limit control the size of every expanded output. Use run_id from list-github-workflow-runs. Note: queued jobs have no logs yet; use watch-github-run to wait for completion.",
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
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const { run_id, repo, job, step, offset, limit } = params;

      const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
      const jobsOut = await ghExec(["api", `/repos/${effectiveRepo}/actions/runs/${run_id}/jobs`], {
        cwd: ctx.cwd,
        signal,
        input: params,
      });
      const { jobs } = Value.Parse(jobsResponseSchema, JSON.parse(jobsOut));

      const fetchJobLog = (jobId: number): Promise<string> =>
        getJobLog(String(run_id), jobId, effectiveRepo, signal, ctx.cwd, params);

      // ── Fetch a specific step's logs (requires `job`) ─────────────────
      if (step !== undefined && step !== null) {
        onUpdate?.({
          content: [{ type: "text", text: `Fetching job list...` }],
          details: {},
        });
        const stepResult = await renderStepLog(
          { runId: String(run_id), job, step, offset, limit },
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
        { runId: String(run_id), job, offset, limit },
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

      const result = await runGh(args, { cwd: ctx.cwd, signal, timeout: 600_000 });

      const exitCode = result.code;
      const stdout = result.stdout;
      const stderr = result.stderr;

      // Exit code 2 means one or more checks failed
      if (exitCode === 2) {
        return {
          content: [
            { type: "text", text: `## PR #${number} CI Checks - FAILED\n\n${stdout}\n${stderr}` },
          ],
          details: { status: "failure", exitCode, input: params },
        };
      }

      if (exitCode !== 0) {
        throw new Error(`gh pr checks --watch failed: ${stderr || `exit code ${exitCode}`}`);
      }

      return {
        content: [{ type: "text", text: `## PR #${number} CI Checks - PASSED\n\n${stdout}` }],
        details: { status: "success", exitCode: 0, input: params },
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
