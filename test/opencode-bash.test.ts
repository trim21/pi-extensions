import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { type BwrapRuntime, createBwrapRuntime } from "../src/bwrap/runtime.js";
import opencodeBash from "../src/opencode/bash.js";

interface RegisteredTool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (...args: any[]) => Promise<any>;
}

beforeAll(() => {
  // Bash 输出运行时落盘到 agent-dir/tmp：测试环境指向可写的临时目录
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
      "Command timed out before completion.",
    ]);
    expect(result.details).toEqual({ timeout: true });
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
      "workdir",
      "timeout",
      "dangerouslyDisableSandbox",
    ]);
  });
});
