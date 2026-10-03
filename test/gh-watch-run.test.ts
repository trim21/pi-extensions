/**
 * `watchRun`（`src/gh/base.ts`）：替代 `gh run watch` 的轮询。测三个分支——运行结束、
 * 超过上限以超时结束（不挂住）、signal 中止；以及每轮都通过 onUpdate 报当前状态。
 * 末尾再跑一次 `watch-github-run` 工具的接线（cassette 喂 `actions/runs/<id>`）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { GhClient, watchRun } from "../src/gh/base.js";
import { addWatchRunTool } from "../src/gh/tools/watch-run.js";
import type { GithubReads } from "../src/lib/github-reads.js";
import { createToolBus } from "../src/lib/tool-bus.js";
import { githubCassette } from "./github-fixtures.js";

/** 只实现 watchRun 要用的 `run`；按顺序返回快照，用完停在最后一个。 */
function readsReturning(snapshots: unknown[]): {
  reads: GithubReads;
  run: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const run = vi.fn(async () => {
    const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
    index += 1;
    return snapshot;
  });
  return { reads: { run } as unknown as GithubReads, run };
}

const PENDING = { id: 99, status: "in_progress", html_url: "https://example.test/run/99" };
const DONE = {
  id: 99,
  status: "completed",
  conclusion: "success",
  html_url: "https://example.test/run/99",
};

/** 工具结果的文本（结果里只有文本内容）。 */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

describe("watchRun", () => {
  it("运行结束时返回完成结果，并在每轮报一次状态", async () => {
    const { reads, run } = readsReturning([PENDING, PENDING, DONE]);
    const updates: string[] = [];

    const result = await watchRun({
      owner: "o",
      repo: "r",
      runId: 99,
      reads,
      signal: new AbortController().signal,
      intervalMs: 1,
      deadlineMs: 1_000,
      onUpdate: (msg) => {
        updates.push(msg.content.map((part) => part.text ?? "").join(""));
      },
    });

    expect(result.outcome).toBe("completed");
    expect(result.run).toEqual(DONE);
    expect(run.mock.calls).toHaveLength(3);
    expect(updates).toHaveLength(3);
    expect(updates.at(-1)).toContain("success");
    expect(updates[0]).toContain("Watching workflow run 99");
  });

  it("超过上限以超时结束，而不是一直等下去", async () => {
    const { reads } = readsReturning([PENDING]);

    const result = await watchRun({
      owner: "o",
      repo: "r",
      runId: 99,
      reads,
      signal: new AbortController().signal,
      intervalMs: 1,
      deadlineMs: 5,
    });

    expect(result.outcome).toBe("timeout");
    expect(result.run).toEqual(PENDING);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(5);
  });

  it("signal 中止时抛错（由调用方上报为中止）", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      watchRun({
        owner: "o",
        repo: "r",
        runId: 99,
        reads: readsReturning([PENDING]).reads,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("响应缺少 run 的必需字段时报出 schema 错误", async () => {
    await expect(
      watchRun({
        owner: "o",
        repo: "r",
        runId: 99,
        reads: readsReturning([{ status: "completed" }]).reads,
        signal: new AbortController().signal,
        intervalMs: 1,
        deadlineMs: 1_000,
      }),
    ).rejects.toThrow(/id/);
  });
});

describe("watch-github-run 工具", () => {
  it("已在第一个快照就结束的 run 直接出报告，并带结构化载荷", async () => {
    const cassette = githubCassette({
      "repos/o/r/actions/runs/99": {
        body: {
          id: 99,
          name: "CI",
          status: "completed",
          conclusion: "success",
          head_branch: "master",
          html_url: "https://example.test/run/99",
        },
      },
    });
    const gh = new GhClient(cassette.fetch, { token: async () => "test-token" });
    const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
    const bus = createToolBus(pi);
    addWatchRunTool(gh, bus);

    const updates: string[] = [];
    const result = await bus.executeTool(
      "watch-github-run",
      { run_id: 99, repo: "o/r" },
      {
        ctx: { cwd: "/tmp" } as never,
        onUpdate: (message: { content: { type: string; text?: string }[] }) => {
          updates.push(message.content.map((part) => part.text ?? "").join(""));
        },
      },
    );
    const text = textOf(result);

    expect(text).toContain("## Workflow Run 99 Completed");
    expect(text).toContain("success");
    expect(updates[0]).toContain("Watching workflow run 99");
    expect(result.structuredResult).toMatchObject({
      ok: true,
      value: { run: { id: 99, conclusion: "success" } },
    });
  });
});
