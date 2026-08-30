import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AftTransportPool } from "@cortexkit/aft-bridge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/aft/bridge.js", () => ({
  createAftState: vi.fn(),
  shutdownAftPool: vi.fn(),
  callAftTool: vi.fn(),
  resolveSessionId: vi.fn(() => "session-test"),
}));

vi.mock("../src/aft/config.js", () => ({
  loadAftConfig: vi.fn(),
}));

import { createAftState } from "../src/aft/bridge.js";
import { type AftReadConfig, loadAftConfig, type SemanticRemote } from "../src/aft/config.js";
import aftExtension from "../src/aft/index.js";

/** 不属于模型面的引擎能力：回滚、OS 级文件操作与巡检。 */
const NEVER_REGISTERED = [
  "aft_move",
  "aft_delete",
  "aft_safety",
  "aft_inspect",
  "aft_conflicts",
  "ast_edit",
];

const ALWAYS_REGISTERED = ["aft_callgraph", "aft_outline", "aft_zoom"];

const REMOTE: SemanticRemote = {
  backend: "openai_compatible",
  baseUrl: "https://gateway.internal/v1",
  apiKeyEnv: undefined,
  apiKey: undefined,
};

interface Surface {
  names: string[];
  descriptions: string[];
  notices: string[];
  startError: unknown;
}

async function registerWith(config: Partial<AftReadConfig>, poolError?: Error): Promise<Surface> {
  vi.mocked(loadAftConfig).mockReturnValue({
    enabled: true,
    semanticSearch: false,
    semanticRemote: undefined,
    ...config,
  });
  if (poolError) {
    vi.mocked(createAftState).mockRejectedValue(poolError);
  } else {
    vi.mocked(createAftState).mockResolvedValue({
      logger: {
        getLogFilePath: () => "/tmp/aft-plugin.log",
        log: () => {},
        warn: () => {},
        error: () => {},
        drain: async () => {},
      },
      pool: {
        pool: { getBridge: () => ({}) } as unknown as AftTransportPool,
        projectRoot: process.cwd(),
      },
    });
  }

  const names: string[] = [];
  const descriptions: string[] = [];
  const notices: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const pi = {
    registerTool: (tool: { name: string; description?: string }) => {
      names.push(tool.name);
      if (tool.description) descriptions.push(tool.description);
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  aftExtension(pi);
  const notifyCtx = { ui: { notify: (message: string) => void notices.push(message) } };
  let startError: unknown;
  const startHandler = handlers.get("session_start");
  if (startHandler) {
    try {
      await startHandler({}, notifyCtx);
    } catch (error) {
      startError = error;
    }
  }
  return { names, descriptions, notices, startError };
}

describe("aft tool surface", () => {
  beforeEach(() => {
    vi.mocked(createAftState).mockReset();
    vi.mocked(loadAftConfig).mockReset();
    // 扩展会往 process 挂 beforeExit 兜底关闭 bridge；本文件只测注册决策，
    // 逐个用例真挂会撑爆默认 10 个 listener 上限。
    vi.spyOn(process, "once").mockImplementation(() => process);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the five core tools when semantic_search is off", async () => {
    const { names, notices } = await registerWith({});
    expect(names.toSorted()).toEqual(ALWAYS_REGISTERED.toSorted());
    expect(notices).toEqual([]);
  });

  it("registers aft_search when an external embedding backend is configured", async () => {
    const { names, notices } = await registerWith({ semanticSearch: true, semanticRemote: REMOTE });
    expect(names).toContain("aft_search");
    expect(notices).toEqual([]);
  });

  it("skips aft_search with a reason when only the flag is on", async () => {
    const { names, notices } = await registerWith({ semanticSearch: true });
    expect(names).not.toContain("aft_search");
    expect(notices.join("\n")).toContain("external embedding backend");
  });

  it("registers nothing when disabled", async () => {
    const { names } = await registerWith({ enabled: false });
    expect(names).toEqual([]);
  });

  it("keeps tools registered and surfaces the init error from session_start", async () => {
    const { names, notices, startError } = await registerWith(
      {},
      new Error("AFT binary not found"),
    );
    expect(names.toSorted()).toEqual(ALWAYS_REGISTERED.toSorted());
    expect(startError).toBeInstanceOf(Error);
    expect((startError as Error).message).toContain("AFT binary not found");
    expect(notices).toEqual([]);
  });

  it.each(NEVER_REGISTERED)("never registers %s", async (name) => {
    const off = await registerWith({});
    const on = await registerWith({ semanticSearch: true, semanticRemote: REMOTE });
    expect(off.names).not.toContain(name);
    expect(on.names).not.toContain(name);
  });

  it("keeps aft prompt and source text free of unregistered tool names", async () => {
    const text = readdirSync("src/aft")
      .filter((entry) => entry.endsWith(".md") || entry.endsWith(".ts"))
      .map((entry) => readFileSync(join("src/aft", entry), "utf8"))
      .join("\n");
    for (const name of NEVER_REGISTERED) {
      expect(text, `${name} must not be recommended to the model`).not.toContain(name);
    }
  });

  it("does not advertise self-service rollback in tool descriptions", async () => {
    const { descriptions } = await registerWith({});
    expect(descriptions.join("\n")).not.toMatch(/撤销|回退|恢复|undo|restore|checkpoint/i);
  });
});
