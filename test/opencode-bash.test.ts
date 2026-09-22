import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  BashInterruptedError,
  type BwrapRuntime,
  createBwrapRuntime,
} from "../src/bwrap/runtime.js";
import opencodeBash from "../src/opencode/bash.js";

interface RegisteredTool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (...args: any[]) => Promise<any>;
}

const SESSION_ID = "test-session";

beforeAll(() => {
  // Bash 输出运行时落盘到 agent-dir/tmp/{session-id}：测试环境指向可写的临时目录
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cc-opencode-bash-"));
});

function loadBashTool(): { tool: RegisteredTool; runtime: BwrapRuntime } {
  let tool: RegisteredTool | undefined;
  const runtime = createBwrapRuntime();
  runtime.setMode(process.cwd(), "allow-all");
  opencodeBash(
    {
      registerTool(def: RegisteredTool) {
        tool = def;
      },
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      exec: vi.fn(),
    } as never,
    runtime,
  );
  return { tool: tool!, runtime };
}

function context(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: {
      setWidget: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
    },
    sessionManager: { getSessionId: () => SESSION_ID },
    signal: undefined,
    abort: vi.fn(),
  } as never;
}

describe("opencode bash", () => {
  it("returns output and a status text block on success", async () => {
    const { tool } = loadBashTool();
    const result = await tool.execute(
      "id",
      { command: "printf done", timeout: 5_000 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.content.map((block: { text: string }) => block.text)).toEqual([
      "done",
      "Command exited with code 0.",
    ]);
  });

  it("does not throw on non-zero exit: returns output plus exit code text", async () => {
    const { tool } = loadBashTool();
    const result = await tool.execute(
      "id",
      { command: "sh -c 'echo boom; exit 4'", timeout: 5_000 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.content.map((block: { text: string }) => block.text)).toEqual([
      "boom\n",
      "Command exited with code 4.",
    ]);
    expect(result.details).toMatchObject({ exitCode: 4, truncated: false });
  });

  it("appends the sandbox status as an extra content block for failures inside the sandbox", async () => {
    const { tool, runtime } = loadBashTool();
    // runtime 的沙箱状态文本由 bwrap-runtime 的单测断言，这里只验证它作为额外一块被附上
    vi.spyOn(runtime, "execute").mockResolvedValue({
      exitCode: 4,
      sandboxHint: "sandbox status",
      output: "boom\n",
      truncation: { truncated: false } as never,
    });
    const result = await tool.execute(
      "id",
      { command: "x", timeout: 5_000 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.content.map((block: { text: string }) => block.text)).toMatchInlineSnapshot(`
      [
        "boom
      ",
        "Command exited with code 4.",
        "sandbox status",
      ]
    `);
  });

  it("does not append the sandbox status for successful commands", async () => {
    const { tool, runtime } = loadBashTool();
    vi.spyOn(runtime, "execute").mockResolvedValue({
      exitCode: 0,
      sandboxHint: "sandbox status",
      output: "done",
      truncation: { truncated: false } as never,
    });
    const result = await tool.execute(
      "id",
      { command: "x", timeout: 5_000 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.content.map((block: { text: string }) => block.text)).toMatchInlineSnapshot(`
      [
        "done",
        "Command exited with code 0.",
      ]
    `);
  });

  it("appends the user sandbox reminder as an extra content block", async () => {
    const { tool, runtime } = loadBashTool();
    vi.spyOn(runtime, "execute").mockResolvedValue({
      exitCode: 0,
      sandboxHint: undefined,
      sandboxReminder: "user sandbox reminder",
      output: "done",
      truncation: { truncated: false } as never,
    });
    const result = await tool.execute(
      "id",
      { command: "x", timeout: 5_000 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.content.map((block: { text: string }) => block.text)).toEqual([
      "done",
      "Command exited with code 0.",
      "user sandbox reminder",
    ]);
  });

  it("appends the sandbox status when the command timed out inside the sandbox", async () => {
    const { tool, runtime } = loadBashTool();
    vi.spyOn(runtime, "execute").mockRejectedValue(
      new BashInterruptedError(
        "timeout",
        "still here",
        { output: "partial", truncation: { truncated: false } as never },
        "sandbox status",
        20,
        new Error("timed out"),
      ),
    );
    const result = await tool.execute(
      "id",
      { command: "x", timeout: 20 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.content.map((block: { text: string }) => block.text)).toMatchInlineSnapshot(`
      [
        "partial

      Command exceeded timeout of 20 ms. Retry with a larger timeout if the command is expected to take longer.",
        "sandbox status",
      ]
    `);
  });

  it("appends the user sandbox reminder after a timeout", async () => {
    const { tool, runtime } = loadBashTool();
    vi.spyOn(runtime, "execute").mockRejectedValue(
      new BashInterruptedError(
        "timeout",
        "still here",
        { output: "partial", truncation: { truncated: false } as never },
        undefined,
        20,
        new Error("timed out"),
        "user sandbox reminder",
      ),
    );
    const result = await tool.execute(
      "id",
      { command: "x", timeout: 20 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.content.map((block: { text: string }) => block.text)).toEqual([
      "partial\n\nCommand exceeded timeout of 20 ms. Retry with a larger timeout if the command is expected to take longer.",
      "user sandbox reminder",
    ]);
  });

  it("returns a timeout message instead of throwing", async () => {
    const { tool } = loadBashTool();
    const result = await tool.execute(
      "id",
      { command: "sleep 1", timeout: 20 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.content.map((block: { text: string }) => block.text)).toEqual([
      "Command exceeded timeout of 20 ms. Retry with a larger timeout if the command is expected to take longer.",
    ]);
    expect(result.details).toEqual({ timeout: true });
  });

  it("includes partial output before the timeout message", async () => {
    const { tool } = loadBashTool();
    const result = await tool.execute(
      "id",
      { command: "printf partial; sleep 1", timeout: 20 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.content.map((block: { text: string }) => block.text)).toEqual([
      "partial\n\nCommand exceeded timeout of 20 ms. Retry with a larger timeout if the command is expected to take longer.",
    ]);
    expect(result.details).toEqual({ timeout: true });
  });

  it("returns partial output with an abort status instead of throwing", async () => {
    const { tool } = loadBashTool();
    const controller = new AbortController();
    const promise = tool.execute(
      "id",
      { command: "printf partial; sleep 1", timeout: 5_000 },
      controller.signal,
      undefined,
      context(process.cwd()),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await promise;
    expect(result.content.map((block: { text: string }) => block.text)).toEqual([
      expect.stringMatching(/^partial\n\nCommand aborted by user after \d+\.\d seconds$/),
    ]);
    expect(result.details).toEqual({});
  });

  it("rejects an invalid timeout", async () => {
    const { tool } = loadBashTool();
    await expect(
      tool.execute(
        "id",
        { command: "printf x", timeout: -1 },
        undefined,
        undefined,
        context(process.cwd()),
      ),
    ).rejects.toThrow(/timeout must be between/);
  });

  it("does not expose background parameters", async () => {
    const { tool } = loadBashTool();
    expect(Object.keys(tool.parameters.properties!)).toEqual([
      "command",
      "description",
      "workdir",
      "timeout",
      "dangerouslyDisableSandbox",
    ]);
  });

  it("deletes the temp file when output is not truncated", async () => {
    const { tool } = loadBashTool();
    const result = await tool.execute(
      "id",
      { command: "printf small", timeout: 5_000 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.details.truncated).toBe(false);
    expect(result.details.fullOutputPath).toBeUndefined();
    expect(await readdir(join(getAgentDir(), "tmp", SESSION_ID))).toEqual([]);
  });

  it("keeps the truncated output under the session dir", async () => {
    const { tool } = loadBashTool();
    const result = await tool.execute(
      "id",
      { command: "seq 1 10000", timeout: 5_000 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(result.details.truncated).toBe(true);
    expect(result.details.fullOutputPath).toBe(
      join(getAgentDir(), "tmp", SESSION_ID, basename(result.details.fullOutputPath as string)),
    );
    expect(await readdir(join(getAgentDir(), "tmp", SESSION_ID))).toHaveLength(1);
  });
});
