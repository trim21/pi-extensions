/**
 * `src/lib/github-reads.ts` 的端点测试：REST 路径、分页、limit、媒体类型、下载与错误契约。
 * 全部走 `test/github-fixtures.ts` 的 cassette（无网络），断言的是「请求打到哪个 URL」与
 * 「响应原样透传」，渲染与载荷的形状由工具级测试负责。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGithubReads, type GithubReads } from "../src/lib/github-reads.js";
import { type FixtureRoutes, githubCassette } from "./github-fixtures.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

function setup(routes: FixtureRoutes): { reads: GithubReads; calls: string[] } {
  const cassette = githubCassette(routes);
  return {
    reads: createGithubReads({ fetch: cassette.fetch, token: async () => "test-token" }),
    calls: cassette.calls,
  };
}

describe("issue / PR 详情", () => {
  it("读取单个 issue 与 PR", async () => {
    const { reads, calls } = setup({
      "repos/o/r/issues/7": { body: { number: 7, html_url: "https://example.test/i/7" } },
      "repos/o/r/pulls/9": { body: { number: 9, merged_at: null } },
    });

    expect(await reads.issue("o", "r", 7)).toEqual({
      number: 7,
      html_url: "https://example.test/i/7",
    });
    expect(await reads.pull("o", "r", 9)).toEqual({ number: 9, merged_at: null });
    expect(calls).toEqual([
      "https://api.github.com/repos/o/r/issues/7",
      "https://api.github.com/repos/o/r/pulls/9",
    ]);
  });
});

describe("列表端点", () => {
  it("issues 列表滤掉混在里面的 PR，并截到 limit", async () => {
    const { reads } = setup({
      "repos/o/r/issues": {
        body: [
          { number: 1 },
          { number: 2, pull_request: { url: "https://example.test/pulls/2" } },
          { number: 3 },
        ],
      },
    });

    expect(await reads.listIssues("o", "r", { limit: 2 })).toEqual([{ number: 1 }, { number: 3 }]);
  });

  it("列表过滤条件映射成 REST 参数（@me 按字面量转发）", async () => {
    const { reads, calls } = setup({ "repos/o/r/pulls": { body: [] } });

    await reads.listPulls("o", "r", {
      state: "open",
      label: "bug",
      assignee: "@me",
      author: "someone",
      milestone: "v1",
    });

    const url = calls[0] ?? "";
    expect(url).toContain("state=open");
    expect(url).toContain("labels=bug");
    expect(url).toContain("assignee=%40me");
    expect(url).toContain("creator=someone");
    expect(url).toContain("milestone=v1");
  });

  it("merged 状态在列表端点按 all 处理（REST 没有 merged 过滤）", async () => {
    const { reads, calls } = setup({ "repos/o/r/pulls": { body: [] } });

    await reads.listPulls("o", "r", { state: "merged" });

    expect(calls[0]).toContain("state=all");
    expect(calls[0]).not.toContain("merged");
  });

  it("拒绝非法的 state 取值", async () => {
    const { reads } = setup({});
    await expect(reads.listPulls("o", "r", { state: "weird" })).rejects.toThrow(
      "invalid state: weird",
    );
  });

  it("翻页：带 next link 的第一页之后继续取第二页", async () => {
    // 第 2 页的键必须在更宽的前缀键之前：cassette 按子串匹配，且先命中者胜
    const { reads } = setup({
      "repos/o/r/issues?per_page=30&page=2": { body: [{ number: 2 }] },
      "repos/o/r/issues": {
        body: [{ number: 1 }],
        headers: {
          link: '<https://api.github.com/repos/o/r/issues?per_page=30&page=2>; rel="next"',
        },
      },
    });

    expect(await reads.listIssues("o", "r", {})).toEqual([{ number: 1 }, { number: 2 }]);
  });
});

describe("评论与评审", () => {
  it("issue 评论、行内评审评论与评审摘要", async () => {
    const { reads, calls } = setup({
      "repos/o/r/issues/7/comments": { body: [{ id: 1 }] },
      "repos/o/r/pulls/7/comments": { body: [{ id: 2, diff_hunk: "@@" }] },
      "repos/o/r/pulls/7/reviews": { body: [{ id: 3, state: "APPROVED" }] },
    });

    expect(await reads.issueComments("o", "r", 7)).toEqual([{ id: 1 }]);
    expect(await reads.pullReviewComments("o", "r", 7)).toEqual([{ id: 2, diff_hunk: "@@" }]);
    expect(await reads.pullReviews("o", "r", 7)).toEqual([{ id: 3, state: "APPROVED" }]);
    expect(calls.every((url) => url.includes("per_page=100"))).toBe(true);
  });
});

describe("PR diff", () => {
  it("用 diff 媒体类型取原始 diff 文本", async () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";
    const { reads, calls } = setup({ "repos/o/r/pulls/9": { body: diff } });

    expect(await reads.pullDiff("o", "r", 9)).toBe(diff);
    expect(calls[0]).toContain("/repos/o/r/pulls/9");
  });
});

describe("release", () => {
  it("缺 tag 时取 latest", async () => {
    const { reads, calls } = setup({ "repos/o/r/releases/latest": { body: { tag_name: "v2" } } });

    expect(await reads.release("o", "r", undefined)).toEqual({ tag_name: "v2" });
    expect(calls[0]).toContain("/releases/latest");
  });

  it("给了 tag 时按 tag 取，并支持列表 limit", async () => {
    const { reads, calls } = setup({
      "repos/o/r/releases/tags/v1.2.3": { body: { tag_name: "v1.2.3" } },
      "repos/o/r/releases": { body: [{ tag_name: "v1.2.3" }] },
    });

    expect(await reads.release("o", "r", "v1.2.3")).toEqual({ tag_name: "v1.2.3" });
    expect(await reads.listReleases("o", "r", 5)).toEqual([{ tag_name: "v1.2.3" }]);
    expect(calls[1]).toContain("per_page=5");
  });
});

describe("workflow runs", () => {
  it("workflow 参数先解析成 id 再列 run", async () => {
    const { reads, calls } = setup({
      "repos/o/r/actions/workflows/11/runs": { body: [{ id: 99 }] },
      "repos/o/r/actions/workflows": {
        body: [
          { id: 10, name: "CI", path: ".github/workflows/ci.yml" },
          { id: 11, name: "Release", path: ".github/workflows/release.yml" },
        ],
      },
    });

    expect(await reads.listRuns("o", "r", { workflow: "Release" })).toEqual([{ id: 99 }]);
    expect(calls.some((url) => url.includes("/actions/workflows/11/runs"))).toBe(true);
  });

  it("按文件名也能解析，未命中时报出可选工作流", async () => {
    const { reads, calls } = setup({
      "repos/o/r/actions/workflows/10/runs": { body: [] },
      "repos/o/r/actions/workflows": {
        body: [{ id: 10, name: "CI", path: ".github/workflows/ci.yml" }],
      },
    });

    await reads.listRuns("o", "r", { workflow: "ci.yml" });
    expect(calls.some((url) => url.includes("/actions/workflows/10/runs"))).toBe(true);

    await expect(reads.listRuns("o", "r", { workflow: "nope" })).rejects.toThrow(
      'workflow "nope" not found (available: CI)',
    );
  });

  it("不带 workflow 时列仓库的全部 run，截到 limit", async () => {
    const { reads, calls } = setup({
      "repos/o/r/actions/runs": { body: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    });

    expect(await reads.listRuns("o", "r", { limit: 2 })).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls[0]).toContain("per_page=2");
  });

  it("单个 run 与仓库信息原样透传", async () => {
    const { reads } = setup({
      "repos/o/r/actions/runs/99": { body: { id: 99, status: "completed" } },
      "repos/o/r": { body: { full_name: "o/r" } },
    });

    expect(await reads.run("o", "r", 99)).toEqual({ id: 99, status: "completed" });
    expect(await reads.repository("o", "r")).toEqual({ full_name: "o/r" });
  });
});

describe("CI 日志与下载", () => {
  it("job 日志返回文本", async () => {
    const { reads, calls } = setup({
      "actions/jobs/5/logs": { body: "2026-01-01T00:00:00Z line one\n" },
    });

    expect(await reads.jobLogs("o", "r", 5)).toBe("2026-01-01T00:00:00Z line one\n");
    expect(calls[0]).toContain("/repos/o/r/actions/jobs/5/logs");
  });

  it("资产下载流式写盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reads-"));
    dirs.push(dir);
    const dest = join(dir, "asset.bin");
    const { reads, calls } = setup({ "releases/assets/7": { body: { payload: "binary" } } });

    await reads.downloadAssetTo("o", "r", 7, dest);

    expect(JSON.parse(await readFile(dest, "utf8"))).toEqual({ payload: "binary" });
    expect(calls[0]).toBe("https://api.github.com/repos/o/r/releases/assets/7");
  });

  it("源码归档的 URL 带 zipball / tarball 与 ref", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reads-"));
    dirs.push(dir);
    const { reads, calls } = setup({
      "zipball/v1.2.3": { body: { ok: "zip" } },
      tarball: { body: { ok: "tar" } },
    });

    await reads.downloadArchiveTo("o", "r", "zip", "v1.2.3", join(dir, "a.zip"));
    await reads.downloadArchiveTo("o", "r", "tar.gz", undefined, join(dir, "b.tar.gz"));

    expect(calls[0]).toBe("https://api.github.com/repos/o/r/zipball/v1.2.3");
    expect(calls[1]).toBe("https://api.github.com/repos/o/r/tarball");
    expect(JSON.parse(await readFile(join(dir, "a.zip"), "utf8"))).toEqual({ ok: "zip" });
  });

  it("下载失败时报出状态、URL 与 GitHub 的 message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reads-"));
    dirs.push(dir);
    const { reads } = setup({
      "releases/assets/7": { body: { message: "Not Found" }, status: 404 },
    });

    await expect(reads.downloadAssetTo("o", "r", 7, join(dir, "x"))).rejects.toThrow(
      "GitHub API error (HTTP 404) at https://api.github.com/repos/o/r/releases/assets/7: Not Found",
    );
  });
});
