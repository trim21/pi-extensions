import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { BwrapConfig } from "../src/bwrap/core.js";
import type { LspServerAdapter } from "../src/lib/lsp/adapter.js";
import { createToolServices } from "../src/lib/tool-services.js";

function plainAdapter(): LspServerAdapter {
  return {
    id: "rust",
    extensions: [],
    spawn: async () => {
      return;
    },
  };
}

const unsubscribe = (): void => {};

/** 只记录 handler 的 pi 桩：本文件只关心 session_start 的派发顺序。 */
function createFakePi(): {
  pi: ExtensionAPI;
  emitSessionStart: (ctx: unknown) => Promise<void>;
} {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    events: { on: () => unsubscribe, emit: () => {} },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return unsubscribe;
    },
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerTool: vi.fn(),
    getActiveTools: () => [],
    setActiveTools: vi.fn(),
    exec: vi.fn(),
  } as unknown as ExtensionAPI;

  return {
    pi,
    async emitSessionStart(ctx) {
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({ type: "session_start", reason: "startup" }, ctx);
      }
    },
  };
}

describe("createToolServices 的 LSP 启用回调", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-tool-services-"));
    await writeFile(
      join(dir, "lsp.json"),
      JSON.stringify({ servers: { rust: { command: "rust-analyzer", include: ["**/*.rs"] } } }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(): unknown {
    return {
      cwd: dir,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: { fg: (_c: string, text: string) => text },
      },
    };
  }

  it("回调晚于 session_start 设置时，仍能收到已启用的服务", async () => {
    const { pi, emitSessionStart } = createFakePi();
    const services = createToolServices(pi, {
      adapters: [plainAdapter()],
      globalConfigPath: join(dir, "lsp.json"),
    });

    // manager 的 session_start handler 先跑（入口这时还没选出本会话的工具集）
    await emitSessionStart(ctx());

    const handler = vi.fn();
    services.setLspEnabledHandler(handler);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toBe(services.manager.mustLazyGetService());
  });

  it("回调先设置时，后续 session_start 直接派发", async () => {
    const { pi, emitSessionStart } = createFakePi();
    const services = createToolServices(pi, {
      adapters: [plainAdapter()],
      globalConfigPath: join(dir, "lsp.json"),
    });

    const handler = vi.fn();
    services.setLspEnabledHandler(handler);
    await emitSessionStart(ctx());

    expect(handler).toHaveBeenCalledOnce();
  });

  it("没有启用的服务器时不派发", async () => {
    const { pi, emitSessionStart } = createFakePi();
    // 配置里声明了服务器但没有对应 adapter → 一台都没启用
    const services = createToolServices(pi, {
      adapters: [],
      globalConfigPath: join(dir, "lsp.json"),
    });

    await emitSessionStart(ctx());

    const handler = vi.fn();
    services.setLspEnabledHandler(handler);

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("createToolServices 注入 shell env", () => {
  const noSandbox: BwrapConfig = {
    fs: { mode: "allow-all", writablePaths: [], extraWritablePaths: [], denyPaths: [] },
    network: { mode: "allow-all", allowlist: [] },
    extraArgs: [],
  };
  let agentDir: string;

  beforeAll(() => {
    // 命令输出落盘到 agent-dir/tmp：指向临时目录，避免写用户真实目录
    agentDir = mkdtempSync(join(tmpdir(), "pi-tool-services-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterAll(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("shellEnv 经 runtime 到达 bash 命令", async () => {
    const { pi } = createFakePi();
    const services = createToolServices(pi, {
      adapters: [],
      sandbox: noSandbox,
      shellEnv: { GIT_EDITOR: "true" },
    });

    const result = await services.runtime.execute({
      toolCallId: "test",
      command: 'printf %s "$GIT_EDITOR"',
      ctx: {
        cwd: process.cwd(),
        hasUI: false,
        sessionManager: { getSessionId: () => "test-session" },
      } as never,
    });

    expect(result).toMatchObject({ exitCode: 0, output: "true" });
  });
});
