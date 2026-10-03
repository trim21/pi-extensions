/**
 * GitHub Read-Only Tools Extension
 *
 * Provides individual read-only tools for GitHub operations. 取数走 octokit REST；
 * 只有「当前仓库」解析（`gh repo view`）与 token 获取（`gh auth token`）用系统 `gh`。
 *
 * Layout:
 *   - `base.ts`            shared helpers (result shaping, GhClient, repo resolution, checks watch)
 *   - `schemas.ts`         structured-output schemas
 *   - `render.ts`          text rendering of REST responses
 *   - `tools/<name>.ts`    one tool per file, each exporting `add<Name>Tool(gh, bus)`
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
 * Proxy (shared by the `gh` subprocess and the octokit requests):
 *   ~/.pi/agent/proxy.json: { "proxy": "http://127.0.0.1:7890", "noProxy": "localhost" }
 *   HTTPS_PROXY / HTTP_PROXY / ALL_PROXY and NO_PROXY are used instead for the
 *   fields the config file leaves out; the config is read through `src/lib/egress.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ToolBus } from "../lib/tool-bus.js";
import { registerToolsOnSessionStart } from "../lib/tool-registration.js";
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

/** 本工具集的工具：入口从它取注册函数（gh 不可用时返回 undefined）。 */
export function createGithubTools(): { register(bus: ToolBus): void } | undefined {
  // Windows 上禁用：gh 可执行文件的探测（无扩展名 + POSIX 路径）与进程
  // 管理（SIGTERM 信号语义）都是 POSIX 假设，不做 Windows 适配。
  if (process.platform === "win32") {
    return undefined;
  }

  // Fail fast: the `gh` CLI is the only backend for these tools. Without it the
  // extension registers nothing and reports the problem at session start, so
  // the user gets one clear error instead of a dozen failing tool calls.
  if (!isGhAvailable()) {
    return undefined;
  }

  const gh = new GhClient();
  return {
    register(bus) {
      addReadIssueTool(gh, bus);
      addListIssuesTool(gh, bus);
      addReadIssueCommentsTool(gh, bus);
      addReadPrTool(gh, bus);
      addListPrsTool(gh, bus);
      addReadPrDiffTool(gh, bus);
      addReadPrStatusTool(gh, bus);
      addReadPrCommentsTool(gh, bus);
      addReadCiLogsTool(gh, bus);
      addListWorkflowRunsTool(gh, bus);
      addGetWorkflowJobsTool(gh, bus);
      addReadRepoTool(gh, bus);
      addListReleasesTool(gh, bus);
      addReadReleaseTool(gh, bus);
      addDownloadReleaseAssetsTool(gh, bus);
      addWaitPrChecksTool(gh, bus);
      addWaitCommitChecksTool(gh, bus);
      addWatchRunTool(gh, bus);
    },
  };
}

export default function ghReadonlyTools(pi: ExtensionAPI): void {
  // Windows 上禁用：gh 可执行文件的探测与进程管理都是 POSIX 假设。
  if (process.platform === "win32") {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("gh-readonly tools are disabled on Windows.", "warning");
    });
    return;
  }

  // gh 不可用时一个工具都不注册，只在会话启动时报告一次问题。
  const tools = createGithubTools();
  if (!tools) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        "gh CLI not found in PATH: GitHub read-only tools are disabled. Install GitHub CLI (https://cli.github.com/) and reload the session.",
        "error",
      );
    });
    return;
  }

  registerToolsOnSessionStart(pi, (bus) => {
    tools.register(bus);
  });
}
