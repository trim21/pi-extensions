/**
 * Regression tests for `read-github-pr`（`src/gh/tools/read-pr.ts`）：payload 是一整行
 * 很长的 JSON（80KB 的正文），line/byte 截断曾经把超过 50KB 的 payload 整个抹成空输出 ——
 * 工具返回空文本、`isError: false`、也没有截断提示，只在 JSON 很大的 PR 上出现。
 *
 * 取数已从 `gh pr view --json` 换成 octokit 的 `pulls.get`；文本输出也已经不存在（工具只
 * 返回结构化载荷），所以这里断言「大 payload 完整地进结构化载荷、不被任何预算截断」。
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
  return bus.executeCodemodeTool(
    "read-github-pr",
    { number: 142, repo: "o/r" },
    {
      ctx: { cwd: "/tmp" } as never,
    },
  );
}

describe("read-github-pr", () => {
  it("returns the >50KB payload whole", async () => {
    const result = await executeReadPr();

    expect(result).toEqual({ ok: true, value: PULL });
  });
});
