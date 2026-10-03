/**
 * Regression tests for `read-github-pr`（`src/gh/tools/read-pr.ts`）：payload 是一整行
 * 很长的 JSON（80KB 的正文），line/byte 截断曾经把超过 50KB 的payload 整个抹成空输出 ——
 * 工具返回空文本、`isError: false`、也没有截断提示，只在 JSON 很大的 PR 上出现。
 *
 * 取数已从 `gh pr view --json` 换成 octokit 的 `pulls.get`，所以这里用 cassette 喂响应，
 * 断言「文本仍是完整 JSON、没有被截断、载荷与文本同源」这条回归行为没变。
 *
 * Run: npx vitest run test/pr.test.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { GhClient } from "../src/gh/base.js";
import { addReadPrTool } from "../src/gh/tools/read-pr.js";
import { createToolBus } from "../src/lib/tool-bus.js";
import { githubCassette } from "./github-fixtures.js";

const BODY = "x".repeat(80 * 1024);

const PULL = {
  number: 142,
  title: "big PR",
  state: "open",
  body: BODY,
  html_url: "https://example.test/pr/142",
  user: { login: "trim21" },
  labels: [],
  created_at: "2026-10-03T00:00:00Z",
  updated_at: "2026-10-03T01:00:00Z",
  closed_at: null,
  merged_at: null,
  additions: 1,
  deletions: 0,
  changed_files: 1,
};

async function executeReadPr() {
  const cassette = githubCassette({ "repos/o/r/pulls/142": { body: PULL } });
  const gh = new GhClient(cassette.fetch, { token: async () => "test-token" });
  const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
  const bus = createToolBus(pi);
  addReadPrTool(gh, bus);
  return bus.executeTool(
    "read-github-pr",
    { number: 142, repo: "o/r" },
    {
      ctx: { cwd: "/tmp" } as never,
    },
  );
}

/** 工具结果的文本（结果里只有文本内容）。 */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

describe("read-github-pr", () => {
  it("returns a >50KB single-line JSON payload through whole", async () => {
    const result = await executeReadPr();
    const text = textOf(result);

    // 文本是完整 JSON（格式化后那行 80KB 的正文没有被截断）
    expect(text.length).toBeGreaterThan(50 * 1024);
    expect(JSON.parse(text)).toEqual(PULL);
    expect(result.details).toMatchObject({ truncated: false });
    // 结构化结果与文本同源：codemode 脚本拿它就不必再解析 JSON 文本
    expect(result.structuredResult).toEqual({ ok: true, value: PULL });
  });
});
