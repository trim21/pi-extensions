/**
 * 迁移到 octokit 之后的一次性接线测试：把每个工具跑一遍，确认它读的是 REST 端点、
 * 结构化载荷来自这份响应。解析细节由 `gh-diff-stats.test.ts` 与 `github-reads.test.ts`
 * 覆盖，这里只验证「工具 → 读层」这一段接线。
 *
 * 全部走 cassette（无网络、无 gh 子进程），`repo` 一律显式给出，因此不会触发
 * `gh repo view` 的「当前仓库」解析。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { GhClient } from "../src/gh/base.js";
import { addListReleasesTool } from "../src/gh/tools/list-releases.js";
import { addListWorkflowRunsTool } from "../src/gh/tools/list-workflow-runs.js";
import { addReadIssueTool } from "../src/gh/tools/read-issue.js";
import { addReadIssueCommentsTool } from "../src/gh/tools/read-issue-comments.js";
import { addReadPrTool } from "../src/gh/tools/read-pr.js";
import { addReadPrDiffTool } from "../src/gh/tools/read-pr-diff.js";
import { addReadReleaseTool } from "../src/gh/tools/read-release.js";
import { addReadRepoTool } from "../src/gh/tools/read-repo.js";
import { createToolBus, type ToolBus } from "../src/lib/tool-bus.js";
import { type FixtureRoutes, githubCassette } from "./github-fixtures.js";

/** 注册一个工具并返回总线；`register` 是各 `add*Tool(gh, bus)` 的统一签名。 */
function busWith(
  routes: FixtureRoutes,
  register: (gh: GhClient, bus: ToolBus) => void,
): { bus: ToolBus; calls: string[] } {
  const cassette = githubCassette(routes);
  const gh = new GhClient(cassette.fetch, { token: async () => "test-token" });
  const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
  const bus = createToolBus(pi);
  register(gh, bus);
  return { bus, calls: cassette.calls };
}

const ctx = { cwd: "/tmp" } as never;

/** 经 codemode 执行入口跑一次工具，返回结构化结果。 */
function run(bus: ToolBus, name: string, args: unknown) {
  return bus.executeCodemodeTool(name, args, { ctx });
}

describe("REST 接线的工具", () => {
  it("read-github-issue 直接给 REST 原物", async () => {
    const issue = {
      number: 7,
      title: "bug",
      state: "open",
      html_url: "https://github.com/o/r/issues/7",
      user: { login: "trim21" },
      labels: [{ name: "bug" }],
      created_at: "2026-01-01T00:00:00Z",
      closed_at: null,
    };
    const { bus } = busWith({ "repos/o/r/issues/7": { body: issue } }, addReadIssueTool);

    expect(await run(bus, "read-github-issue", { number: 7, repo: "o/r" })).toEqual({
      ok: true,
      value: issue,
    });
  });

  it("label 的 description 为 null 时仍然是成功结果", async () => {
    // GitHub 对没有描述的 label 给 `"description": null`（不是缺字段），schema 必须放行
    const issue = {
      number: 7,
      title: "bug",
      state: "open",
      labels: [
        { name: "bug", color: "d73a4a", description: null },
        { name: "dependencies", color: "0366d6", description: null },
      ],
    };
    const { bus } = busWith({ "repos/o/r/issues/7": { body: issue } }, addReadIssueTool);

    expect(await run(bus, "read-github-issue", { number: 7, repo: "o/r" })).toMatchObject({
      ok: true,
      value: { labels: [{ description: null }, { description: null }] },
    });
  });

  it("read-github-pr 的 label 与 REST 原物一致", async () => {
    const pull = {
      number: 177,
      title: "chore(deps): update eslint",
      state: "open",
      html_url: "https://github.com/o/r/pull/177",
      user: { login: "app/renovate", name: null },
      labels: [{ name: "dependencies", color: "0366d6", description: null }],
      created_at: "2026-10-03T00:00:00Z",
      merged_at: null,
    };
    const { bus } = busWith({ "repos/o/r/pulls/177": { body: pull } }, addReadPrTool);

    expect(await run(bus, "read-github-pr", { number: 177, repo: "o/r" })).toEqual({
      ok: true,
      value: pull,
    });
  });

  it("read-github-issue-comments 给出 comments 数组", async () => {
    const comments = [
      { id: 1, body: "hi", user: { login: "trim21" }, created_at: "2026-01-01T00:00:00Z" },
    ];
    const { bus } = busWith(
      { "repos/o/r/issues/7/comments": { body: comments } },
      addReadIssueCommentsTool,
    );

    expect(await run(bus, "read-github-issue-comments", { number: 7, repo: "o/r" })).toEqual({
      ok: true,
      value: { comments },
    });
  });

  it("read-github-pr-diff 的载荷是解析出的统计", async () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "index 1111111..2222222 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+added",
    ].join("\n");
    const { bus } = busWith({ "repos/o/r/pulls/9": { body: diff } }, addReadPrDiffTool);

    expect(await run(bus, "read-github-pr-diff", { number: 9, repo: "o/r" })).toEqual({
      ok: true,
      value: {
        files: [{ path: "src/x.ts", additions: 1, deletions: 0 }],
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      },
    });
  });

  it("list-github-releases 列出每个 release", async () => {
    const { bus } = busWith(
      {
        "repos/o/r/releases": {
          body: [
            {
              tag_name: "v2.0.0",
              name: "2.0",
              draft: false,
              prerelease: false,
              published_at: "2026-09-30T02:40:02Z",
            },
            { tag_name: "v1.0.0", name: "1.0", published_at: "2026-01-01T00:00:00Z" },
          ],
        },
      },
      addListReleasesTool,
    );

    expect(await run(bus, "list-github-releases", { repo: "o/r" })).toMatchObject({
      ok: true,
      value: { releases: [{ tag_name: "v2.0.0" }, { tag_name: "v1.0.0" }] },
    });
  });

  it("read-github-repo 的载荷是 repos.get 的响应", async () => {
    const { bus } = busWith(
      {
        "repos/o/r": {
          body: {
            full_name: "o/r",
            description: "demo",
            html_url: "https://github.com/o/r",
            visibility: "public",
            language: "TypeScript",
            default_branch: "master",
            stargazers_count: 3,
            forks_count: 0,
            open_issues_count: 2,
            license: { name: "MIT License" },
            pushed_at: "2026-10-03T14:50:26Z",
            created_at: "2026-06-20T10:09:24Z",
          },
        },
      },
      addReadRepoTool,
    );

    expect(await run(bus, "read-github-repo", { repo: "o/r" })).toMatchObject({
      ok: true,
      value: { repo: { full_name: "o/r" } },
    });
  });

  it("read-github-release 带资产清单", async () => {
    const { bus } = busWith(
      {
        "repos/o/r/releases/tags/v1.2.3": {
          body: {
            tag_name: "v1.2.3",
            name: "1.2.3",
            html_url: "https://example.test/release",
            published_at: "2026-09-30T02:40:02Z",
            author: { login: "trim21" },
            assets: [{ id: 5, name: "checksums.txt", size: 12, download_count: 3 }],
            body: "notes",
          },
        },
      },
      addReadReleaseTool,
    );

    expect(await run(bus, "read-github-release", { tag: "v1.2.3", repo: "o/r" })).toMatchObject({
      ok: true,
      value: { release: { tag_name: "v1.2.3", assets: [{ id: 5 }] } },
    });
  });

  it("list-github-workflow-runs 把 status 过滤传给 REST", async () => {
    const { bus, calls } = busWith(
      {
        "repos/o/r/actions/runs": {
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 37131067543,
                name: "CI",
                status: "completed",
                conclusion: "success",
                head_branch: "master",
                event: "push",
                created_at: "2026-10-03T14:50:27Z",
                html_url: "https://example.test/run/1",
              },
            ],
          },
        },
      },
      addListWorkflowRunsTool,
    );

    expect(
      await run(bus, "list-github-workflow-runs", { repo: "o/r", status: "success" }),
    ).toMatchObject({
      ok: true,
      value: { runs: [{ id: 37131067543, conclusion: "success" }] },
    });
    expect(calls[0]).toContain("status=success");
  });
});
