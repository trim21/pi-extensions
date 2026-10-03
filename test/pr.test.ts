/**
 * Regression tests for `read-github-pr` (the handler in
 * `src/gh/tools/read-pr.ts`): `gh pr view --json` prints a single line of JSON,
 * and line-based truncation used to blank any payload over 50KB entirely — the
 * tool returned an empty toolcall output with `isError: false` and no hint of
 * truncation, only on PRs whose JSON payload got large.
 *
 * Run: npx vitest run test/pr.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import registerTools from "../src/gh/index.js";

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    return true;
  }

  exit(code: number, stdout = ""): void {
    if (stdout) {
      this.stdout.write(stdout);
    }
    this.emit("close", code);
  }
}

interface ToolDef {
  name: string;
  execute: (
    _id: string,
    params: { number: number | string; repo?: string },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: { cwd?: string },
  ) => Promise<{
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
    structuredResult?: { ok: boolean; value?: unknown };
  }>;
}

function getExecutor(): ToolDef["execute"] {
  const tools: unknown[] = [];
  const pi = {
    on: (event: string, handler: (...args: never[]) => unknown) => {
      if (event === "session_start") {
        void handler(
          { type: "session_start", reason: "startup" } as never,
          { model: undefined, cwd: process.cwd(), ui: { notify: () => false } } as never,
        );
      }
    },
    registerTool: (t: unknown) => {
      tools.push(t);
      return tools.length;
    },
  };
  registerTools(pi as unknown as Parameters<typeof registerTools>[0]);
  const tool = tools.find((t): t is ToolDef => (t as { name?: string }).name === "read-github-pr");
  if (!tool) {
    throw new Error("read-github-pr not registered");
  }
  return tool.execute;
}

const exec = process.platform === "win32" ? undefined : getExecutor();

afterEach(() => {
  spawnMock.mockReset();
});

describe.skipIf(process.platform === "win32")("read-github-pr", () => {
  it("returns a >50KB single-line JSON payload through whole", async () => {
    const json = JSON.stringify({
      number: 142,
      title: "big PR",
      state: "OPEN",
      body: "x".repeat(80 * 1024),
      comments: [],
    });
    const procs: FakeChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const proc = new FakeChildProcess();
      procs.push(proc);
      return proc;
    });

    const promise = exec!("id", { number: 142, repo: "o/r" }, undefined, undefined, {
      cwd: undefined,
    });
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    procs[0].exit(0, json);

    const result = await promise;
    expect(result.content[0].text).toBe(json);
    expect(result.details.truncated).toBe(false);
    // 结构化结果与文本同源：codemode 脚本拿它就不必再解析 JSON 文本
    expect(result.structuredResult).toEqual({
      ok: true,
      value: {
        number: 142,
        title: "big PR",
        state: "OPEN",
        body: "x".repeat(80 * 1024),
        comments: [],
      },
    });
  });
});
