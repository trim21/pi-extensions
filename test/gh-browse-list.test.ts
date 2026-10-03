/**
 * `list-github-issues` / `list-github-prs` 的两条分支（浏览走 `gh … --json`、关键词搜索走
 * octokit）现在归一成同一套 `SearchHit`，因此文本与结构化载荷共用一份数据。这里用假 gh
 * 进程驱动工具（`executeTool` 会跑一遍总线的 schema 复核），断言文本与载荷。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GhClient } from "../src/gh/base.js";
import { addListIssuesTool } from "../src/gh/tools/list-issues.js";
import { addListPrsTool } from "../src/gh/tools/list-prs.js";
import { createToolBus, type ToolBus } from "../src/lib/tool-bus.js";

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

/** 假 gh：按 argv 决定 stdout，退出码 0。 */
function fakeGh(respond: (args: string[]) => string): void {
  spawnMock.mockImplementation((_file: string, args: string[]) => {
    const child = new FakeChildProcess();
    const stdout = respond(args);
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end("");
      child.emit("close", 0);
    });
    return child;
  });
}

afterEach(() => {
  spawnMock.mockReset();
});

const ISSUES_JSON = JSON.stringify([
  {
    number: 14,
    title: "Dependency Dashboard",
    state: "OPEN",
    url: "https://github.com/trim21/pi-extensions/issues/14",
    labels: [{ name: "dependencies" }],
    milestone: null,
    assignees: [{ login: "trim21" }],
    author: { login: "app/renovate" },
    comments: [{ id: "1" }, { id: "2" }],
    createdAt: "2026-06-20T10:30:53Z",
    updatedAt: "2026-10-03T13:06:52Z",
    closedAt: null,
  },
]);

function setupBus(gh: GhClient): ToolBus {
  const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
  const bus = createToolBus(pi);
  addListIssuesTool(gh, bus);
  addListPrsTool(gh, bus);
  return bus;
}

const ctx = { cwd: "/tmp" } as never;

/** 工具结果的文本（结果里只有文本内容）。 */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

describe("list-github-issues 的浏览分支", () => {
  it("文本与载荷同源：TSV 与归一化后的行", async () => {
    fakeGh((args) => {
      if (args[0] === "repo") {
        return JSON.stringify({ nameWithOwner: "trim21/pi-extensions" });
      }
      return ISSUES_JSON;
    });
    const bus = setupBus({} as GhClient);

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
  });

  it("显式 repo 时文本不带 repo 列", async () => {
    fakeGh(() => ISSUES_JSON);
    const bus = setupBus({} as GhClient);

    const result = await bus.executeTool(
      "list-github-issues",
      { repo: "trim21/pi-extensions" },
      { ctx },
    );

    expect(textOf(result)).toBe("14\topen\tDependency Dashboard\tdependencies\t2026-10-03");
  });

  it("PR 的 merged 状态由 mergedAt 推断", async () => {
    fakeGh((args) =>
      args[0] === "repo"
        ? JSON.stringify({ nameWithOwner: "trim21/pi-extensions" })
        : JSON.stringify([
            {
              number: 176,
              title: "structured results",
              state: "MERGED",
              url: "https://example.test/pr/176",
              labels: [],
              milestone: null,
              assignees: [],
              author: { login: "trim21" },
              comments: [],
              createdAt: "2026-10-03T00:00:00Z",
              updatedAt: "2026-10-03T01:00:00Z",
              closedAt: "2026-10-03T01:00:00Z",
              mergedAt: "2026-10-03T01:00:00Z",
            },
          ]),
    );
    const bus = setupBus({} as GhClient);

    const result = await bus.executeTool(
      "list-github-prs",
      { repo: "trim21/pi-extensions", fields: "number,state,mergedAt" },
      { ctx },
    );

    expect(textOf(result)).toBe("176\tmerged\t2026-10-03");
  });
});

describe("list-github-issues 的搜索分支", () => {
  it("搜索命中同样进载荷", async () => {
    const gh = {
      search: {
        search: vi.fn(async () => [
          {
            number: 7,
            state: "closed" as const,
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
        ]),
      },
    } as unknown as GhClient;
    const bus = setupBus(gh);

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
});
