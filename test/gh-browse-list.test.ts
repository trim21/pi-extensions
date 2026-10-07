/**
 * `list-github-issues` / `list-github-prs` 的浏览分支现在走 octokit 的 REST 列表端点
 * （关键词搜索那条分支本来就走 octokit）。这里用录制/回放的 cassette 喂响应：
 * 请求 URL 与真实调用一致，断言文本与结构化载荷都从同一份 REST 数据产出。
 *
 * 「当前仓库」仍由 `gh repo view` 解析（本次迁移不动这条路径），所以只有一个假 gh 进程。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { GhClient } from "../src/gh/base.js";
import { addListIssuesTool } from "../src/gh/tools/list-issues.js";
import { addListPrsTool } from "../src/gh/tools/list-prs.js";
import { createToolBus, type ToolBus } from "../src/lib/tool-bus.js";
import { type FixtureRoutes, githubCassette } from "./github-fixtures.js";

class FakeChildProcess extends EventEmitter {
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    this.killed = true;
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

/** 假 gh：只为 `gh repo view --json nameWithOwner`（resolveRepo）服务。 */
function fakeRepoView(): void {
  spawnMock.mockImplementation(() => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({ nameWithOwner: "trim21/pi-extensions" }));
      child.stderr.end("");
      child.emit("close", 0);
    });
    return child;
  });
}

afterEach(() => {
  spawnMock.mockReset();
});

const ISSUE = {
  number: 14,
  title: "Dependency Dashboard",
  state: "open",
  html_url: "https://github.com/trim21/pi-extensions/issues/14",
  user: { login: "app/renovate" },
  labels: [{ name: "dependencies" }],
  milestone: null,
  assignees: [{ login: "trim21" }],
  comments: 2,
  created_at: "2026-06-20T10:30:53Z",
  updated_at: "2026-10-03T13:06:52Z",
  closed_at: null,
};

const PULL = {
  number: 176,
  title: "structured results",
  state: "closed",
  html_url: "https://example.test/pr/176",
  user: { login: "trim21" },
  labels: [],
  milestone: null,
  assignees: null,
  created_at: "2026-10-03T00:00:00Z",
  updated_at: "2026-10-03T01:00:00Z",
  closed_at: "2026-10-03T01:00:00Z",
  merged_at: "2026-10-03T01:00:00Z",
};

function setupBus(routes: FixtureRoutes): { bus: ToolBus; calls: string[] } {
  const cassette = githubCassette(routes);
  const gh = new GhClient(cassette.fetch, { token: async () => "test-token" });
  const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
  const bus = createToolBus(pi);
  addListIssuesTool(gh, bus);
  addListPrsTool(gh, bus);
  return { bus, calls: cassette.calls };
}

const ctx = { cwd: "/tmp" } as never;

/** 工具结果的文本（结果里只有文本内容）。 */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

describe("list-github-issues 的浏览分支", () => {
  it("文本与载荷同源：TSV 与归一化后的行", async () => {
    fakeRepoView();
    const { bus, calls } = setupBus({
      "repos/trim21/pi-extensions/issues": { body: [ISSUE] },
    });

    const result = await bus.executeTool("list-github-issues", {}, { ctx });

    // 浏览只查一个仓库，因此文本不带 repo 列；repo 仍进载荷
    const text = "14\topen\tDependency Dashboard\tdependencies\t2026-10-03";
    expect(textOf(result)).toBe(text);
    expect(result.structuredResult).toEqual({
      ok: true,
      value: {
        text,
        items: [
          {
            number: 14,
            state: "open",
            title: "Dependency Dashboard",
            url: "https://github.com/trim21/pi-extensions/issues/14",
            repo: "trim21/pi-extensions",
            author: "app/renovate",
            labels: ["dependencies"],
            milestone: "",
            assignees: ["trim21"],
            comments: 2,
            createdAt: "2026-06-20",
            updatedAt: "2026-10-03",
            closedAt: "",
            mergedAt: "",
          },
        ],
      },
    });
    expect(calls.some((url) => url.includes("/repos/trim21/pi-extensions/issues"))).toBe(true);
  });

  it("显式 repo 时文本不带 repo 列", async () => {
    const { bus } = setupBus({ "repos/trim21/pi-extensions/issues": { body: [ISSUE] } });

    const result = await bus.executeTool(
      "list-github-issues",
      { repo: "trim21/pi-extensions" },
      { ctx },
    );

    expect(textOf(result)).toBe("14\topen\tDependency Dashboard\tdependencies\t2026-10-03");
  });

  it("PR 的 merged 状态由 merged_at 推断", async () => {
    const { bus } = setupBus({ "repos/trim21/pi-extensions/pulls": { body: [PULL] } });

    const result = await bus.executeTool(
      "list-github-prs",
      { repo: "trim21/pi-extensions", fields: "number,state,mergedAt" },
      { ctx },
    );

    expect(textOf(result)).toBe("176\tmerged\t2026-10-03");
  });

  it("@me 按字面量传给 REST，不做展开", async () => {
    const { bus, calls } = setupBus({ "repos/trim21/pi-extensions/issues": { body: [] } });

    await bus.executeTool(
      "list-github-issues",
      { repo: "trim21/pi-extensions", author: "@me" },
      { ctx },
    );

    expect(calls.some((url) => url.includes("creator=%40me"))).toBe(true);
  });
});

describe("list-github-issues 的搜索分支", () => {
  // 纯 issue 条目在真实响应里没有 pull_request 键（只有 PR 条目才有）
  it("搜索命中的纯 issue 条目没有 pull_request 键也照常进载荷", async () => {
    const { bus } = setupBus({
      "/search/issues": {
        body: {
          total_count: 1,
          items: [
            {
              number: 7,
              state: "closed",
              title: "old issue",
              html_url: "https://example.test/issues/7",
              repository_url: "https://api.github.com/repos/other/repo",
              user: { login: "someone" },
              labels: [],
              milestone: null,
              assignees: [],
              comments: 0,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
              closed_at: "2026-01-02T00:00:00Z",
            },
          ],
        },
      },
    });

    const result = await bus.executeTool(
      "list-github-issues",
      { keywords: "old", state: "all" },
      { ctx },
    );

    expect(textOf(result)).toBe("other/repo\t7\tclosed\told issue\t\t2026-01-02");
    expect(result.structuredResult).toEqual({
      ok: true,
      value: {
        text: "other/repo\t7\tclosed\told issue\t\t2026-01-02",
        items: [
          {
            number: 7,
            state: "closed",
            title: "old issue",
            url: "https://example.test/issues/7",
            repo: "other/repo",
            author: "someone",
            labels: [],
            milestone: "",
            assignees: [],
            comments: 0,
            createdAt: "2026-01-01",
            updatedAt: "2026-01-02",
            closedAt: "2026-01-02",
            mergedAt: "",
          },
        ],
      },
    });
  });

  // PR 条目一定带 pull_request：未合并为 merged_at: null，已合并为时间戳
  it("搜索命中的 PR 条目按 merged_at 推断 merged（null 视为未合并）", async () => {
    const { bus } = setupBus({
      "/search/issues": {
        body: {
          total_count: 2,
          items: [
            {
              number: 12,
              state: "closed",
              title: "merged pr",
              html_url: "https://example.test/pull/12",
              repository_url: "https://api.github.com/repos/other/repo",
              user: { login: "someone" },
              labels: [],
              milestone: null,
              assignees: [],
              comments: 1,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
              closed_at: "2026-01-02T00:00:00Z",
              pull_request: { merged_at: "2026-01-02T00:00:00Z" },
            },
            {
              number: 13,
              state: "open",
              title: "open pr",
              html_url: "https://example.test/pull/13",
              repository_url: "https://api.github.com/repos/other/repo",
              user: { login: "someone" },
              labels: [],
              milestone: null,
              assignees: [],
              comments: 0,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-03T00:00:00Z",
              closed_at: null,
              pull_request: { merged_at: null },
            },
          ],
        },
      },
    });

    const result = await bus.executeTool(
      "list-github-issues",
      { keywords: "pr", state: "all" },
      { ctx },
    );

    expect(textOf(result)).toBe(
      "other/repo\t12\tmerged\tmerged pr\t\t2026-01-02\nother/repo\t13\topen\topen pr\t\t2026-01-03",
    );
  });
});
