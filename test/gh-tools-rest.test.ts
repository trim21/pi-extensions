/**
 * 迁移到 octokit 之后的一次性接线测试：把每个工具跑一遍，确认它读的是 REST 端点、
 * 文本与结构化载荷同源。渲染与解析的细节由 `gh-render.test.ts` 与 `github-reads.test.ts`
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

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
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

    const result = await bus.executeTool("read-github-issue", { number: 7, repo: "o/r" }, { ctx });

    expect(JSON.parse(textOf(result))).toEqual(issue);
    expect(result.structuredResult).toEqual({ ok: true, value: issue });
  });

  it("read-github-issue-comments 给出 comments 数组", async () => {
    const comments = [
      { id: 1, body: "hi", user: { login: "trim21" }, created_at: "2026-01-01T00:00:00Z" },
    ];
    const { bus } = busWith(
      { "repos/o/r/issues/7/comments": { body: comments } },
      addReadIssueCommentsTool,
    );

    const result = await bus.executeTool(
      "read-github-issue-comments",
      { number: 7, repo: "o/r" },
      { ctx },
    );

    expect(JSON.parse(textOf(result))).toEqual({ comments });
    expect(result.structuredResult).toEqual({ ok: true, value: { comments } });
  });

  it("read-github-pr-diff 的文本是 diff、载荷是解析出的统计", async () => {
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

    const result = await bus.executeTool(
      "read-github-pr-diff",
      { number: 9, repo: "o/r" },
      { ctx },
    );

    expect(textOf(result)).toBe(diff);
    expect(result.structuredResult).toEqual({
      ok: true,
      value: {
        text: diff,
        files: [{ path: "src/x.ts", additions: 1, deletions: 0 }],
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      },
    });
  });

  it("list-github-releases 每行一个 release，最新标记由顺序推断", async () => {
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

    const result = await bus.executeTool("list-github-releases", { repo: "o/r" }, { ctx });

    expect(textOf(result)).toBe("v2.0.0\tlatest\t2026-09-30\t2.0\nv1.0.0\t\t2026-01-01\t1.0");
    expect(result.structuredResult).toMatchObject({
      ok: true,
      value: { releases: [{ tag_name: "v2.0.0" }, { tag_name: "v1.0.0" }] },
    });
  });

  it("read-github-repo 渲染概览，载荷是 repos.get 的响应", async () => {
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

    const result = await bus.executeTool("read-github-repo", { repo: "o/r" }, { ctx });

    expect(textOf(result)).toBe(
      [
        "o/r — demo",
        "public · TypeScript · default branch master · stars 3 · forks 0 · open issues 2",
        "https://github.com/o/r",
        "pushed 2026-10-03 · created 2026-06-20 · MIT License",
      ].join("\n"),
    );
    expect(result.structuredResult).toMatchObject({
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

    const result = await bus.executeTool(
      "read-github-release",
      { tag: "v1.2.3", repo: "o/r" },
      { ctx },
    );

    expect(textOf(result)).toContain("- checksums.txt 12 bytes, 3 downloads");
    expect(textOf(result)).toContain("notes");
    expect(result.structuredResult).toMatchObject({
      ok: true,
      value: { release: { tag_name: "v1.2.3", assets: [{ id: 5 }] } },
    });
  });

  it("list-github-workflow-runs 渲染行列表并把 status 过滤传给 REST", async () => {
    const { bus, calls } = busWith(
      {
        "repos/o/r/actions/runs": {
          body: [
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
      addListWorkflowRunsTool,
    );

    const result = await bus.executeTool(
      "list-github-workflow-runs",
      { repo: "o/r", status: "success" },
      { ctx },
    );

    expect(textOf(result)).toBe(
      "37131067543\tcompleted\tsuccess\tCI\tmaster\tpush\t2026-10-03\thttps://example.test/run/1",
    );
    expect(calls[0]).toContain("status=success");
    expect(result.structuredResult).toMatchObject({
      ok: true,
      value: { runs: [{ id: 37131067543, conclusion: "success" }] },
    });
  });
});
