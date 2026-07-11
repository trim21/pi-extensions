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
 *   - watch-github-pr-checks: Watch PR CI checks
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
import { Type } from "typebox";
import { spawn } from "node:child_process";

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
      const out = await ghExec(pi, ["issue", "view", String(number), ...repoArgs(repo)], {
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
      const out = await ghExec(pi, ["pr", "view", String(number), ...repoArgs(repo)], {
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
      stat: Type.Optional(
        Type.Boolean({ description: "Show only file stats instead of full diff" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo, stat } = params as {
        number: number | string;
        repo?: string;
        stat?: boolean;
      };
      const args = ["pr", "diff", String(number), ...repoArgs(repo)];
      if (stat) args.push("--stat");
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
    description: "Get review comments on a GitHub pull request.",
    promptSnippet: "Read GitHub PR comments",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      reviews: Type.Optional(
        Type.Boolean({ description: "Include PR reviews instead of just comments" }),
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
        out = await ghExec(pi, ["pr", "reviews", String(number), ...repoArgs(repo)], {
          cwd: ctx.cwd,
          signal,
        });
      } else {
        out = await ghExec(pi, ["pr", "view", String(number), ...repoArgs(repo), "--comments"], {
          cwd: ctx.cwd,
          signal,
        });
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
        ["issue", "view", String(number), ...repoArgs(repo), "--comments"],
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
      "Get logs from a GitHub Actions workflow run. Use run ID from read-github-workflow-runs.",
    promptSnippet: "Read GitHub CI logs",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      job: Type.Optional(Type.String({ description: "Filter to specific job name" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const { run_id, repo, job } = params as {
        run_id: number | string;
        repo?: string;
        job?: string;
      };
      onUpdate?.({
        content: [{ type: "text", text: `Fetching CI logs for run ${run_id}...` }],
        details: {},
      });

      const args = ["run", "view", String(run_id), ...repoArgs(repo), "--log"];
      if (job) args.push("--job", job);
      const out = await ghExec(pi, args, { cwd: ctx.cwd, signal });

      const { text, truncated } = truncate(out, 3000, 80 * 1024);
      return {
        content: [{ type: "text", text }],
        details: { truncated },
      };
    },
  });

  // ── read-github-workflow-jobs ──────────────────────────────────────────────
  pi.registerTool({
    name: "read-github-workflow-jobs",
    label: "GitHub Workflow Jobs",
    description: "Get jobs for a specific workflow run.",
    promptSnippet: "Read GitHub workflow run jobs",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { run_id, repo } = params as { run_id: number | string; repo?: string };
      const out = await ghExec(pi, ["run", "view", String(run_id), ...repoArgs(repo)], {
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

  // ── watch-github-pr-checks ─────────────────────────────────────────────────
  pi.registerTool({
    name: "watch-github-pr-checks",
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
