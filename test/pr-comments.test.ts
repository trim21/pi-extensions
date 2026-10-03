/**
 * Regression tests for `read-github-pr-comments` with `reviews=true`: 它读两个 REST 列表端点，
 * REST 默认一页 30 条，所以必须真的翻页——只用第一页会静默丢掉第 30 条之后的所有评论。
 *
 * 取数已从 `gh api --paginate --slurp` 换成 octokit 的 `paginate`，所以这里用带分页 `link`
 * 头的 cassette 喂两页响应，断言两页都被拼进来。
 *
 * Run: npx vitest run test/pr-comments.test.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { GhClient } from "../src/gh/base.js";
import { addReadPrCommentsTool } from "../src/gh/tools/read-pr-comments.js";
import { createToolBus } from "../src/lib/tool-bus.js";
import { type FixtureRoutes, githubCassette } from "./github-fixtures.js";

/** 第一页带 `link: rel="next"`，第二页没有。路由按子串匹配且先命中者胜，所以第二页在前。 */
function pagedRoutes(base: string, first: unknown[], second: unknown[]): FixtureRoutes {
  return {
    [`${base}?per_page=100&page=2`]: { body: second },
    [`${base}?per_page=100`]: {
      body: first,
      headers: { link: `<https://api.github.com${base}?per_page=100&page=2>; rel="next"` },
    },
  };
}

async function executeReadComments() {
  const routes: FixtureRoutes = {
    ...pagedRoutes("/repos/o/r/pulls/7/comments", [{ id: 1 }], [{ id: 31 }]),
    ...pagedRoutes("/repos/o/r/pulls/7/reviews", [{ id: 2, state: "APPROVED" }], []),
  };
  const cassette = githubCassette(routes);
  const gh = new GhClient(cassette.fetch, { token: async () => "test-token" });
  const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
  const bus = createToolBus(pi);
  addReadPrCommentsTool(gh, bus);
  return bus.executeTool(
    "read-github-pr-comments",
    { number: 7, repo: "o/r", reviews: true },
    { ctx: { cwd: "/tmp" } as never },
  );
}

/** 工具结果的文本（结果里只有文本内容）。 */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

describe("read-github-pr-comments (reviews=true)", () => {
  it("pages both list endpoints and flattens their pages", async () => {
    const result = await executeReadComments();
    const text = textOf(result);

    expect(JSON.parse(text)).toEqual({
      reviews: [{ id: 2, state: "APPROVED" }],
      comments: [{ id: 1 }, { id: 31 }],
    });
    expect(result.structuredResult).toEqual({
      ok: true,
      value: {
        reviews: [{ id: 2, state: "APPROVED" }],
        comments: [{ id: 1 }, { id: 31 }],
      },
    });
  });
});
