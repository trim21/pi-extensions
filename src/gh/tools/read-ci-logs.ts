/**
 * `read-github-ci-logs`: fetch a job's raw log (with a file cache) and index
 * each executed step's block inside it, so the model can read the exact line
 * range of the step it needs.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { RunJob } from "../../lib/github.js";
import { createSeqState } from "../../lib/seq-state.js";
import {
  type GhClient,
  ghExec,
  resolveRepo,
  splitRepo,
  subtitlePendant,
  type ToolCall,
  type ToolResult,
  toPositiveId,
} from "../base.js";

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
  if (match === null) {
    return null;
  }
  const ms = Date.parse(match[1]);
  return Number.isNaN(ms) ? null : ms;
}

/** Collect the depth-1 `Run ` / `Post Run ` headers, in log order. */
function stepHeaders(lines: string[]): StepHeader[] {
  const headers: StepHeader[] = [];
  let depth = 0;
  for (const [i, line] of lines.entries()) {
    if (line.includes("##[endgroup]")) {
      if (depth > 0) {
        depth--;
      }
      continue;
    }
    if (!line.includes("##[group]")) {
      continue;
    }
    depth++;
    if (depth !== 1) {
      continue;
    }
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
  while (end > start && (lines[end - 1] ?? "").trim() === "") {
    end--;
  }
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
  if (span === undefined) {
    return null;
  }
  return log.split("\n").slice(span.start, span.end).join("\n").trimEnd();
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

interface JobIdParams {
  job_id: number | string;
  repo?: string;
}

/** The toolcall handler behind `read-github-ci-logs`. */
async function ciLogs(gh: GhClient, call: ToolCall<JobIdParams>): Promise<ToolResult> {
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
    target = await gh.checks.job(owner, name, jobId, signal);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 404) {
      throw error;
    }
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

export function addReadCiLogsTool(gh: GhClient, pi: ExtensionAPI) {
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
      return ciLogs(gh, { params, ctx, signal, onUpdate });
    },
  });
}
