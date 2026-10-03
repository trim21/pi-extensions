import { mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  BashInterruptedError,
  type BwrapRuntime,
  createBwrapRuntime,
} from "../src/bwrap/runtime.js";
import { createToolBus } from "../src/lib/tool-bus.js";
import { registerBashTool } from "../src/opencode/bash.js";

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
  runtime.setMode(process.cwd(), { fs: "allow-all", network: "allow-all" });
  const pi = {
    registerTool(def: RegisteredTool) {
      tool = def;
    },
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    exec: vi.fn(),
  } as never;
  // 直接走注册函数：不触发 session_start，避免 runtime.setup 的 handler 抹掉
  // 用例预置的沙箱模式。
  registerBashTool(createToolBus(pi), pi, runtime);
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
    expect(result.structuredResult).toEqual({
      ok: true,
      value: { exitCode: 0, output: "done" },
    });
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
    // 非零退出是成功的结构化结果：脚本直接读 exitCode 分支，不需要 try/catch
    expect(result.structuredResult).toEqual({
      ok: true,
      value: { exitCode: 4, output: "boom\n" },
    });
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

  it("returns the full output in the structured result when the text is truncated", async () => {
    const { tool } = loadBashTool();
    const result = await tool.execute(
      "id",
      { command: "seq 1 10000", timeout: 5_000 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    const value = (
      result.structuredResult as { value: { exitCode: number | null; output: string } }
    ).value;
    expect(result.details.truncated).toBe(true);
    // 文本是截断的，载荷是全文（且不含工具追加的截断提示）
    expect(result.content[0].text).toContain("[output capture truncated");
    expect(value.exitCode).toBe(0);
    expect(value.output).not.toContain("[output capture truncated");
    expect(value.output.split("\n").filter(Boolean)).toHaveLength(10_000);
    // 清理本次留下的落盘全文，后面的用例会数这个目录里的文件
    await rm(join(getAgentDir(), "tmp", SESSION_ID), { recursive: true, force: true });
  });

  it("returns a null exit code with the partial output on timeout and abort", async () => {
    const timeout = await loadBashTool().tool.execute(
      "id",
      { command: "printf partial; sleep 5", timeout: 300 },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(timeout.structuredResult).toEqual({
      ok: true,
      value: { exitCode: null, output: "partial" },
    });

    const controller = new AbortController();
    const aborted = loadBashTool().tool.execute(
      "id",
      { command: "printf partial; sleep 5", timeout: 5_000 },
      controller.signal,
      undefined,
      context(process.cwd()),
    );
    setTimeout(() => controller.abort(), 300);
    expect((await aborted).structuredResult).toEqual({
      ok: true,
      value: { exitCode: null, output: "partial" },
    });
    await rm(join(getAgentDir(), "tmp", SESSION_ID), { recursive: true, force: true });
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
