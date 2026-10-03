/**
 * 浏览路径（不带 keywords）的取数：现在走 octokit 的 REST 列表端点，这里断言请求参数的映射
 * ——state / label / author / assignee / milestone / limit 怎么落到 REST 查询上。
 * 文本与结构化载荷的同源性由 `test/gh-browse-list.test.ts` 覆盖。
 */
import { describe, expect, it } from "vitest";

import { createGithubReads, type GithubReads } from "../src/lib/github-reads.js";
import { githubCassette } from "./github-fixtures.js";

/** 记录请求 URL，返回空列表。 */
function capture(): { reads: GithubReads; urls: string[] } {
  const urls: string[] = [];
  const cassette = githubCassette({
    "repos/a/b/issues": { body: [] },
    "repos/a/b/pulls": { body: [] },
  });
  const reads = createGithubReads({
    token: async () => "test-token",
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return cassette.fetch(input, init);
    },
  });
  return { reads, urls };
}

/** 某个 URL 的查询参数。 */
function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("浏览路径的 REST 查询映射", () => {
  it("issue 列表：state / label / author / assignee / milestone 落到 REST 参数", async () => {
    const { reads, urls } = capture();

    await reads.listIssues("a", "b", {
      state: "all",
      label: "bug",
      author: "trim21",
      assignee: "@me",
      milestone: "v1",
      limit: 10,
    });

    const query = queryOf(urls[0]);
    expect(urls[0]).toContain("/repos/a/b/issues");
    expect(query.get("state")).toBe("all");
    expect(query.get("labels")).toBe("bug");
    expect(query.get("creator")).toBe("trim21");
    // @me 按字面量转发，不展开成登录名
    expect(query.get("assignee")).toBe("@me");
    expect(query.get("milestone")).toBe("v1");
    expect(query.get("per_page")).toBe("10");
  });

  it("缺省 state 不传参数（交给 GitHub 的缺省）", async () => {
    const { reads, urls } = capture();

    await reads.listIssues("a", "b", {});

    expect(queryOf(urls[0]).has("state")).toBe(false);
    expect(queryOf(urls[0]).get("per_page")).toBe("30");
  });

  it("PR 列表的 merged 状态落到 state=all（列表端点没有 merged）", async () => {
    const { reads, urls } = capture();

    await reads.listPulls("a", "b", { state: "merged", limit: 5 });

    expect(urls[0]).toContain("/repos/a/b/pulls");
    expect(queryOf(urls[0]).get("state")).toBe("all");
    expect(queryOf(urls[0]).get("per_page")).toBe("5");
  });

  it("issue 列表过滤掉混在里面的 PR", async () => {
    const cassette = githubCassette({
      "repos/a/b/issues": {
        body: [
          {
            number: 1,
            state: "open",
            title: "issue",
            html_url: "u1",
            user: null,
            labels: [],
            milestone: null,
            assignees: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            closed_at: null,
          },
          {
            number: 2,
            state: "open",
            title: "pr",
            html_url: "u2",
            user: null,
            labels: [],
            milestone: null,
            assignees: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            closed_at: null,
            pull_request: { url: "p" },
          },
        ],
      },
    });
    const reads = createGithubReads({ token: async () => "test-token", fetch: cassette.fetch });

    const items = await reads.listIssues("a", "b", {});

    expect(items.map((item) => (item as { number: number }).number)).toEqual([1]);
  });
});
