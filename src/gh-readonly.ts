/**
 * GitHub Read-Only Tools Extension
 *
 * Provides individual read-only tools for GitHub operations using the system's `gh` CLI.
 *
 * Tools:
 *   - read-github-issue: Get issue details
 *   - list-github-issues: List issues
 *   - read-github-issue-comments: Get issue comments
 *   - read-github-pr: Get PR details
 *   - list-github-prs: List PRs
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
 *   - read-github-search: Search GitHub
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
}

// ── helpers ──────────────────────────────────────────────────────────────────

function execGh(
  pi: ExtensionAPI,
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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const killProcess = () => {
      if (!killed) {
        killed = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      }
    };

    if (ctx.signal) {
      if (ctx.signal.aborted) {
        killProcess();
      } else {
        ctx.signal.addEventListener("abort", killProcess, { once: true });
      }
    }

    const timeout = ctx.timeout ?? 30_000;
    if (timeout > 0) {
      timeoutId = setTimeout(killProcess, timeout);
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
      if (ctx.signal) {
        ctx.signal.removeEventListener("abort", killProcess);
      }
      resolve({ stdout, stderr, code: code ?? 0, killed, combined: combined.join("") });
    });

    proc.on("error", (_err) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (ctx.signal) {
        ctx.signal.removeEventListener("abort", killProcess);
      }
      resolve({ stdout, stderr, code: 1, killed, combined: combined.join("") });
    });
  });
}

async function ghExec(
  pi: ExtensionAPI,
  args: string[],
  ctx: { cwd?: string; signal?: AbortSignal },
): Promise<string> {
  const result = await execGh(pi, args, ctx);
  if (result.code !== 0) {
    const msg = result.combined.trim() || `exit code ${result.code}`;
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${msg}`);
  }
  return result.stdout;
}

function repoArgs(repo?: string): string[] {
  return repo ? ["--repo", repo] : [];
}

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
  pi: ExtensionAPI,
  runId: string,
  jobId: number,
  effectiveRepo: string,
  signal: AbortSignal | undefined,
  cwd: string | undefined,
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
      const cached = await readFile(cacheFile, "utf-8");
      return cached;
    } catch {
      // Not cached, fetch from GitHub
    }

    const rawLog = await ghExec(pi, ["api", `/repos/${effectiveRepo}/actions/jobs/${jobId}/logs`], {
      cwd,
      signal,
    });

    // Write to cache
    await mkdir(cacheDir, { recursive: true });
    await withFileMutationQueue(cacheFile, async () => {
      await writeFile(cacheFile, rawLog);
    });

    return rawLog;
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
  pi: ExtensionAPI,
  repo: string | undefined,
  signal: AbortSignal | undefined,
  cwd: string | undefined,
): Promise<string> {
  if (repo) return repo;
  const result = await ghExec(pi, ["repo", "view", "--json", "nameWithOwner"], { cwd, signal });
  return JSON.parse(result).nameWithOwner;
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
 * User-defined steps (actions, shell commands) each emit a `##[group]Run <name>`
 * at depth 1. We match API step names against these group names by stripping the
 * "Run " / "Post Run " prefix and comparing the action name.
 *
 * This handles composite actions correctly: their internal actions produce extra
 * "Run " groups that don't match any API step name, so they are naturally skipped.
 *
 * Step 1 ("Set up job") maps to everything before the first matched "Run "/"Post Run " group.
 * Steps 2+ map to the "Run "/"Post Run " group whose action name matches the step name.
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

  // Step 1 ("Set up job"): everything before the first "Run " or "Post Run " group at depth 1
  if (stepNumber === 1) {
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
            return lines.slice(0, i).join("\n").trimEnd();
          }
        }
      }
    }
    return lines.join("\n").trimEnd();
  }

  // Steps 2+: match "Run "/"Post Run " group by comparing the action name
  // (the part after "Run " or "Post Run " prefix)
  const stepAction = targetStep.name.replace(/^(Run |Post Run )/, "").trim();

  // Collect all "Run "/"Post Run " groups at depth 1
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
          const action = name.replace(/^(Run |Post Run )/, "").trim();
          groups.push({ line: i, action });
        }
      }
    }
  }

  // Find the matching group by action name
  const matchedIdx = groups.findIndex((g) => g.action === stepAction);
  if (matchedIdx === -1) return null;

  const start = groups[matchedIdx].line;
  const end = matchedIdx + 1 < groups.length ? groups[matchedIdx + 1].line : lines.length;
  return lines.slice(start, end).join("\n").trimEnd();
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
      const { number, repo } = params as { number: number | string; repo?: string };
      const out = await ghExec(
        pi,
        [
          "issue",
          "view",
          String(number),
          ...repoArgs(repo),
          "--json",
          "title,state,body,author,createdAt,updatedAt,closedAt,url,labels,assignees,comments,milestone,number",
        ],
        { cwd: ctx.cwd, signal },
      );
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
    },
  });

  // ── list-github-issues ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "list-github-issues",
    label: "GitHub Issues List",
    description: "List GitHub issues with optional filters.",
    promptSnippet: "List GitHub issues",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      state: Type.Optional(Type.String({ description: "open, closed, all (default: open)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 30)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { repo, state, limit } = params as { repo?: string; state?: string; limit?: number };
      const args = ["issue", "list", ...repoArgs(repo)];
      if (state) args.push("--state", state);
      if (limit) args.push("--limit", String(limit));
      const out = await ghExec(pi, args, { cwd: ctx.cwd, signal });
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
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
      const { number, repo } = params as { number: number | string; repo?: string };
      const out = await ghExec(
        pi,
        [
          "pr",
          "view",
          String(number),
          ...repoArgs(repo),
          "--json",
          "title,state,body,author,createdAt,updatedAt,mergedAt,mergedBy,headRefName,baseRefName,url,additions,deletions,changedFiles,labels,assignees,reviewRequests,reviews,comments,number",
        ],
        { cwd: ctx.cwd, signal },
      );
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
    },
  });

  // ── list-github-prs ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "list-github-prs",
    label: "GitHub PRs List",
    description: "List GitHub pull requests with optional filters.",
    promptSnippet: "List GitHub PRs",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      state: Type.Optional(
        Type.String({ description: "open, closed, merged, all (default: open)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 30)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { repo, state, limit } = params as { repo?: string; state?: string; limit?: number };
      const args = ["pr", "list", ...repoArgs(repo)];
      if (state) args.push("--state", state);
      if (limit) args.push("--limit", String(limit));
      const out = await ghExec(pi, args, { cwd: ctx.cwd, signal });
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
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
      const { number, repo } = params as {
        number: number | string;
        repo?: string;
      };
      const args = ["pr", "diff", String(number), ...repoArgs(repo)];
      const out = await ghExec(pi, args, { cwd: ctx.cwd, signal });
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
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
      const { number, repo } = params as { number: number | string; repo?: string };
      const out = await ghExec(pi, ["pr", "checks", String(number), ...repoArgs(repo)], {
        cwd: ctx.cwd,
        signal,
      });
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
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
      const { number, repo, reviews } = params as {
        number: number | string;
        repo?: string;
        reviews?: boolean;
      };
      let out: string;
      if (reviews) {
        const effectiveRepo = await resolveRepo(pi, repo, signal, ctx.cwd);

        const [commentsRaw, reviewsRaw] = await Promise.all([
          ghExec(pi, ["api", `/repos/${effectiveRepo}/pulls/${String(number)}/comments`], {
            cwd: ctx.cwd,
            signal,
          }),
          ghExec(pi, ["api", `/repos/${effectiveRepo}/pulls/${String(number)}/reviews`], {
            cwd: ctx.cwd,
            signal,
          }),
        ]);

        const reviewComments = JSON.parse(commentsRaw);
        const reviewSummaries = JSON.parse(reviewsRaw);

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
          pi,
          ["pr", "view", String(number), ...repoArgs(repo), "--json", "comments"],
          {
            cwd: ctx.cwd,
            signal,
          },
        );
      }
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
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
      const { number, repo } = params as { number: number | string; repo?: string };
      const out = await ghExec(
        pi,
        ["issue", "view", String(number), ...repoArgs(repo), "--json", "comments"],
        { cwd: ctx.cwd, signal },
      );
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
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
      const { repo, limit, status, workflow } = params as {
        repo?: string;
        limit?: number;
        status?: string;
        workflow?: string;
      };
      const args = ["run", "list", ...repoArgs(repo)];
      if (limit) args.push("--limit", String(limit));
      if (status) args.push("--status", status);
      if (workflow) args.push("--workflow", workflow);
      const out = await ghExec(pi, args, { cwd: ctx.cwd, signal });
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
    },
  });

  // ── read-github-ci-logs ────────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-ci-logs",
    label: "GitHub CI Logs",
    description:
      "Get CI logs from a GitHub Actions workflow run. Without step: shows a summary of jobs and steps with their statuses. With step: returns logs for that specific step only, supports offset/limit for long steps. Use run_id from list-github-workflow-runs. Note: queued jobs have no logs yet; use watch-github-run to wait for completion.",
    promptSnippet: "Read GitHub CI logs",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      job: Type.Optional(
        Type.String({
          description:
            "Job name or ID. Required when multiple jobs exist and fetching step logs. Optional when showing summary (filters to that job).",
        }),
      ),
      step: Type.Optional(
        Type.String({
          description:
            "Step name to fetch logs for (from summary table). Omit to show job/step summary instead of raw logs.",
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description:
            "Line number to start reading from within the step's log (1-indexed). Useful for long steps where the error is at the end. Only meaningful with step.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum number of lines to return from the step's log. Only meaningful with step.",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const { run_id, repo, job, step, offset, limit } = params as {
        run_id: number | string;
        repo?: string;
        job?: string;
        step?: string;
        offset?: number;
        limit?: number;
      };

      // ── Fetch specific step logs ───────────────────────────────────────
      if (step !== undefined && step !== null) {
        const effectiveRepo = await resolveRepo(pi, repo, signal, ctx.cwd);

        const jobsResult = await ghExec(
          pi,
          ["api", `/repos/${effectiveRepo}/actions/runs/${run_id}/jobs`],
          { cwd: ctx.cwd, signal },
        );
        const { jobs } = JSON.parse(jobsResult) as {
          jobs: Array<{
            id: number;
            name: string;
            status: string;
            conclusion: string | null;
            steps: Array<{
              name: string;
              number: number;
              status: string;
              conclusion: string | null;
            }>;
          }>;
        };

        if (!jobs || jobs.length === 0) {
          return {
            content: [{ type: "text", text: `No jobs found for run ${run_id}` }],
            details: {},
          };
        }

        let targetJob: (typeof jobs)[0] | undefined;
        if (job) {
          const isNumeric = /^\d+$/.test(job);
          targetJob = jobs.find((j) => (isNumeric ? String(j.id) === job : j.name === job));
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
        } else if (jobs.length === 1) {
          targetJob = jobs[0];
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Multiple jobs found. Specify \`job\`: ${jobs.map((j) => `${j.name} (id: ${j.id})`).join(", ")}`,
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

        const rawLog = await getJobLog(
          pi,
          String(run_id),
          targetJob.id,
          effectiveRepo,
          signal,
          ctx.cwd,
        );

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

        // Calculate full step stats
        const totalLines = stepLog.split("\n").length;

        // Apply offset — slice lines before truncation
        let logToShow = stepLog;
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
          logToShow = stepLog
            .split("\n")
            .slice(offset - 1)
            .join("\n");
          appliedOffset = true;
        }

        const maxLines = limit ?? 3000;
        const maxBytes = 80 * 1024;
        const { text, truncated: tr } = truncate(logToShow, maxLines, maxBytes);

        const shownLines = text.split("\n").length;
        const stepName = targetJob.steps[stepNum - 1]?.name ?? `Step ${stepNum}`;
        const offsetNote = appliedOffset ? ` (lines ${offset!}-${offset! + shownLines - 1})` : "";
        const meta = [
          `## ${targetJob.name} / ${stepName} (step ${stepNum}${offsetNote})`,
          `Total: ${totalLines} lines | Shown: ${shownLines} lines${tr ? " (truncated)" : ""}`,
        ].join("\n");

        return {
          content: [
            { type: "text", text: meta },
            { type: "text", text },
          ],
          details: {
            summary: `Step ${stepNum} — ${targetJob.name} / ${stepName}: ${shownLines} of ${totalLines} lines${tr ? " (truncated)" : ""}`,
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

      // ── Show step summary ──────────────────────────────────────────────
      onUpdate?.({
        content: [{ type: "text", text: `Fetching job list...` }],
        details: {},
      });

      const effectiveRepo = await resolveRepo(pi, repo, signal, ctx.cwd);

      const jobsResult = await ghExec(
        pi,
        ["api", `/repos/${effectiveRepo}/actions/runs/${run_id}/jobs`],
        { cwd: ctx.cwd, signal },
      );
      const { jobs } = JSON.parse(jobsResult) as {
        jobs: Array<{
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
          steps: Array<{
            name: string;
            number: number;
            status: string;
            conclusion: string | null;
          }>;
        }>;
      };

      if (!jobs || jobs.length === 0) {
        return {
          content: [{ type: "text", text: `No jobs found for run ${run_id}` }],
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

      let output = `## CI Summary for Run ${run_id}\n\n`;

      for (const j of targetJobs) {
        const jIcon = statusIcon(j.conclusion);
        output += `### ${jIcon} Job: \`${j.name}\` (id: ${j.id}) — ${j.conclusion ?? j.status}\n\n`;
        output += `| Step# | Name | Status |\n|-------|------|--------|\n`;
        for (const s of j.steps) {
          const sIcon = statusIcon(s.conclusion);
          output += `| ${s.number} | ${s.name} | ${sIcon} ${s.conclusion ?? s.status} |\n`;
        }
        output += `\n`;
      }

      output += `---\n`;
      output += `To view a specific step's logs, call again with \`step=<number>\` (and \`job="<name>"\` if multiple jobs).\n`;

      // ── Auto-include failed step logs ──────────────────────────────────
      const contents: Array<{ type: "text"; text: string }> = [{ type: "text", text: output }];
      let fetchedCount = 0;
      const maxFailed = 5;
      const expandedSteps = new Map<number, Set<number>>(); // jobId → step numbers

      for (const j of targetJobs) {
        if (fetchedCount >= maxFailed) {
          contents.push({
            type: "text",
            text: `(... ${maxFailed} failed step logs shown; use \`step\` to fetch more)`,
          });
          break;
        }

        const failedSteps = j.steps.filter((s) => s.conclusion === "failure");
        if (failedSteps.length === 0) continue;

        try {
          const rawLog = await getJobLog(pi, String(run_id), j.id, effectiveRepo, signal, ctx.cwd);

          for (const fs of failedSteps) {
            if (fetchedCount >= maxFailed) break;
            fetchedCount++;

            const stepLog = extractStepFromLog(rawLog, fs.number, j.steps);
            if (!stepLog) continue;

            const totalLines = stepLog.split("\n").length;
            const maxLines = 500; // tighter limit for auto-included logs
            const { text: logText, truncated: logTr } = truncate(stepLog, maxLines, 60 * 1024);
            const shownLines = logText.split("\n").length;
            const trNote = logTr ? " (truncated)" : "";

            contents.push({
              type: "text",
              text: `\n### ❌ ${j.name} / ${fs.name} (step ${fs.number})\nTotal: ${totalLines} lines | Shown: ${shownLines} lines${trNote}\n`,
            });
            contents.push({ type: "text", text: logText });
            if (!expandedSteps.has(j.id)) expandedSteps.set(j.id, new Set());
            expandedSteps.get(j.id)!.add(fs.number);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          contents.push({
            type: "text",
            text: `\n⚠️ Could not auto-fetch logs for ${j.name}: ${msg}`,
          });
        }
      }

      const totalJobs = targetJobs.length;
      const failedJobs = targetJobs.filter((j) => j.conclusion === "failure").length;
      const totalFailedSteps = targetJobs.reduce(
        (acc, j) => acc + j.steps.filter((s) => s.conclusion === "failure").length,
        0,
      );
      return {
        content: contents,
        details: {
          summary: `${totalJobs} job${totalJobs > 1 ? "s" : ""}, ${failedJobs} failed, ${totalFailedSteps} failed step${totalFailedSteps > 1 ? "s" : ""}`,
          jobs: targetJobs.map((j) => ({
            name: j.name,
            conclusion: j.conclusion,
            steps: stepsDetail(j, expandedSteps.get(j.id)),
          })),
        },
      };
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
      const { run_id, repo } = params as { run_id: number | string; repo?: string };
      const effectiveRepo = await resolveRepo(pi, repo, signal, ctx.cwd);
      const out = await ghExec(pi, ["api", `/repos/${effectiveRepo}/actions/runs/${run_id}/jobs`], {
        cwd: ctx.cwd,
        signal,
      });
      const { text, truncated: tr } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated: tr },
      };
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
      const { repo } = params as { repo?: string };
      const args = ["repo", "view"];
      if (repo) args.push(repo);
      const out = await ghExec(pi, args, { cwd: ctx.cwd, signal });
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
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
      const { repo, limit } = params as { repo?: string; limit?: number };
      const args = ["release", "list", ...repoArgs(repo)];
      if (limit) args.push("--limit", String(limit));
      const out = await ghExec(pi, args, { cwd: ctx.cwd, signal });
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
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
      const { tag, repo } = params as { tag: string; repo?: string };
      const out = await ghExec(pi, ["release", "view", tag, ...repoArgs(repo)], {
        cwd: ctx.cwd,
        signal,
      });
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
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
      const { number, repo, fail_fast } = params as {
        number: number | string;
        repo?: string;
        fail_fast?: boolean;
      };

      onUpdate?.({
        content: [{ type: "text", text: `Watching CI checks for PR #${number}...` }],
        details: {},
      });

      const args = ["pr", "checks", String(number), ...repoArgs(repo), "--watch"];
      if (fail_fast) args.push("--fail-fast");

      const result = await execGh(pi, args, { cwd: ctx.cwd, signal, timeout: 600_000 });

      const exitCode = result.code;
      const stdout = result.stdout;
      const stderr = result.stderr;

      // Exit code 2 means one or more checks failed
      if (exitCode === 2) {
        return {
          content: [
            { type: "text", text: `## PR #${number} CI Checks - FAILED\n\n${stdout}\n${stderr}` },
          ],
          details: { status: "failure", exitCode },
        };
      }

      if (exitCode !== 0) {
        throw new Error(`gh pr checks --watch failed: ${stderr || `exit code ${exitCode}`}`);
      }

      return {
        content: [{ type: "text", text: `## PR #${number} CI Checks - PASSED\n\n${stdout}` }],
        details: { status: "success", exitCode: 0 },
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
      const { run_id, repo } = params as { run_id: number | string; repo?: string };

      onUpdate?.({
        content: [{ type: "text", text: `Watching workflow run ${run_id}...` }],
        details: {},
      });

      const result = await execGh(pi, ["run", "watch", String(run_id), ...repoArgs(repo)], {
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
        details: { exitCode: 0 },
      };
    },
  });

  // ── read-github-search ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-search",
    label: "GitHub Search",
    description: "Search GitHub for repos, issues, or PRs.",
    promptSnippet: "Search GitHub",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("repos"), Type.Literal("issues"), Type.Literal("prs")]),
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { type, query, limit } = params as { type: string; query: string; limit?: number };
      const args = ["search", type, query];
      if (limit) args.push("--limit", String(limit));
      const out = await ghExec(pi, args, { cwd: ctx.cwd, signal });
      const { text, truncated } = truncate(out);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
    },
  });
}
