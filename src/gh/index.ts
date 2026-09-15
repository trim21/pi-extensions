/**
 * GitHub Read-Only Tools Extension
 *
 * Provides individual read-only tools for GitHub operations using the system's `gh` CLI.
 *
 * Layout:
 *   - `base.ts`            shared helpers (gh subprocess, result shaping, REST client, checks watch)
 *   - `tools/<name>.ts`    one tool per file, each exporting `add<Name>Tool(gh, pi)`
 *   - `index.ts`           this file: availability checks + tool registration
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
 *   - list-github-workflow-runs: List workflow runs
 *   - get-github-workflow-jobs: Get workflow run jobs
 *   - read-github-repo: Get repo info
 *   - list-github-releases: List releases
 *   - read-github-release: Get release details
 *   - download-github-release-assets: Download a release's assets with gh credentials
 *   - wait-github-pr-checks: Watch PR CI checks
 *   - wait-github-commit-checks: Watch CI checks of a commit (no PR required)
 *   - watch-github-run: Watch a workflow run
 *
 * Proxy (for the gh CLI and for the octokit-backed search/checks requests):
 *   ~/.pi/agent/proxy.json: { "proxy": "http://127.0.0.1:7890", "noProxy": "localhost" }
 *   HTTPS_PROXY / HTTP_PROXY / ALL_PROXY and NO_PROXY are used instead for the
 *   fields the config file leaves out. The config is read once per process.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { GhClient, isGhAvailable } from "./base.js";
import { addDownloadReleaseAssetsTool } from "./tools/download-release-assets.js";
import { addGetWorkflowJobsTool } from "./tools/get-workflow-jobs.js";
import { addListIssuesTool } from "./tools/list-issues.js";
import { addListPrsTool } from "./tools/list-prs.js";
import { addListReleasesTool } from "./tools/list-releases.js";
import { addListWorkflowRunsTool } from "./tools/list-workflow-runs.js";
import { addReadCiLogsTool } from "./tools/read-ci-logs.js";
import { addReadIssueTool } from "./tools/read-issue.js";
import { addReadIssueCommentsTool } from "./tools/read-issue-comments.js";
import { addReadPrTool } from "./tools/read-pr.js";
import { addReadPrCommentsTool } from "./tools/read-pr-comments.js";
import { addReadPrDiffTool } from "./tools/read-pr-diff.js";
import { addReadPrStatusTool } from "./tools/read-pr-status.js";
import { addReadReleaseTool } from "./tools/read-release.js";
import { addReadRepoTool } from "./tools/read-repo.js";
import { addWaitCommitChecksTool } from "./tools/wait-commit-checks.js";
import { addWaitPrChecksTool } from "./tools/wait-pr-checks.js";
import { addWatchRunTool } from "./tools/watch-run.js";

// Public API re-exports (tests import these from the extension entry).
export * from "./base.js";
export * from "./tools/download-release-assets.js";
export * from "./tools/read-ci-logs.js";
export * from "./tools/read-pr-status.js";

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

  const gh = new GhClient();

  addReadIssueTool(gh, pi);
  addListIssuesTool(gh, pi);
  addReadIssueCommentsTool(gh, pi);
  addReadPrTool(gh, pi);
  addListPrsTool(gh, pi);
  addReadPrDiffTool(gh, pi);
  addReadPrStatusTool(gh, pi);
  addReadPrCommentsTool(gh, pi);
  addReadCiLogsTool(gh, pi);
  addListWorkflowRunsTool(gh, pi);
  addGetWorkflowJobsTool(gh, pi);
  addReadRepoTool(gh, pi);
  addListReleasesTool(gh, pi);
  addReadReleaseTool(gh, pi);
  addDownloadReleaseAssetsTool(gh, pi);
  addWaitPrChecksTool(gh, pi);
  addWaitCommitChecksTool(gh, pi);
  addWatchRunTool(gh, pi);
}
