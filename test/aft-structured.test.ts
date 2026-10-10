/**
 * AFT 感知工具的结构化结果：载荷 = 引擎响应原样字段 + 我们渲染的文本。
 *
 * 用真总线（`createToolBus`）+ `executeTool` 跑，因此顺带覆盖了总线在成功路径上
 * 用 `Value.Parse` 对载荷的复核——schema 只要与真实响应错位（比如把引擎会省略的
 * 字段声明成必需），这里就会红。
 */

import { readFile } from "node:fs/promises";

import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AftState, callAftTool } from "../src/aft/bridge.js";
import {
  type AftToolContext,
  registerCallgraphTool,
  registerOutlineTool,
  registerSearchTool,
  registerZoomTool,
} from "../src/aft/tools.js";
import { createToolBus, type ToolBus } from "../src/lib/tool-bus.js";

vi.mock("../src/aft/bridge.js", () => ({
  callAftTool: vi.fn(),
  resolveSessionId: vi.fn(() => "session-test"),
  SEMANTIC_INDEX_WAIT_TIMEOUT_MS: 3_600_000,
}));

const mockCallAftTool = vi.mocked(callAftTool);

async function fixture(name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(new URL(`fixtures/aft/${name}`, import.meta.url), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** 真总线 + 假 pi：结构化载荷因此会过一遍总线的 schema 复核。 */
function busFor(register: (bus: ToolBus, ctx: AftToolContext) => void): ToolBus {
  const registered: string[] = [];
  const pi = {
    registerTool: (definition: ToolDefinition) => {
      registered.push(definition.name);
    },
  } as unknown as ExtensionAPI;
  const bus = createToolBus(pi);
  const state = {
    pool: { pool: { getBridge: () => ({}) }, projectRoot: "/tmp" },
  } as unknown as AftState;
  register(bus, { getState: () => state });
  return bus;
}

const extCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "s" } } as ExtensionToolContext;

async function run(
  register: (bus: ToolBus, ctx: AftToolContext) => void,
  name: string,
  args: Record<string, unknown>,
) {
  const bus = busFor(register);
  const result = await bus.executeTool(name, args, { ctx: extCtx });
  const payload = result.structuredResult;
  if (payload === undefined || !payload.ok) {
    throw new Error(
      `expected an ok structured result, got ${JSON.stringify(result).slice(0, 400)}`,
    );
  }
  return { result, value: payload.value as Record<string, unknown> };
}

describe("aft_outline 结构化结果", () => {
  beforeEach(() => mockCallAftTool.mockReset());

  it("单文件模式：载荷只有 text 与 complete", async () => {
    const response = await fixture("outline-file.json");
    mockCallAftTool.mockResolvedValue({ text: response.text as string, response });

    const { value } = await run(registerOutlineTool, "aft_outline", { target: "/tmp/a.ts" });

    expect(value).toEqual({ success: true, complete: true, text: response.text });
  });

  it("files 模式：文件条目原样进载荷", async () => {
    const response = await fixture("outline-files.json");
    mockCallAftTool.mockResolvedValue({ text: response.text as string, response });

    const { value } = await run(registerOutlineTool, "aft_outline", {
      target: "/tmp",
      files: true,
    });

    expect(value.files).toEqual([{ path: "a.ts", language: "typescript", symbols: 2, lines: 6 }]);
    expect(value.walk_truncated).toBe(false);
    // envelope 的 id 不进载荷
    expect(value).not.toHaveProperty("id");
  });
});

describe("aft_zoom 结构化结果", () => {
  beforeEach(() => mockCallAftTool.mockReset());

  it("符号源码与调用注解原样进载荷", async () => {
    const response = await fixture("zoom-greet.json");
    mockCallAftTool.mockResolvedValue({ text: response.text as string, response });

    const { value } = await run(registerZoomTool, "aft_zoom", {
      path: "/tmp/a.ts",
      symbols: "greet",
    });

    expect(value.name).toBe("greet");
    expect(value.kind).toBe("function");
    expect(value.range).toEqual({ start_line: 1, start_col: 1, end_line: 3, end_col: 2 });
    expect(value.content).toContain("export function greet");
    expect(value.annotations).toEqual({ calls_out: [], called_by: [] });
  });
});

describe("aft_callgraph 结构化结果", () => {
  beforeEach(() => mockCallAftTool.mockReset());

  it("callers：分组调用点原样进载荷", async () => {
    const response = await fixture("callgraph-callers.json");
    mockCallAftTool.mockResolvedValue({ text: response.text as string, response });

    const { value } = await run(registerCallgraphTool, "aft_callgraph", {
      op: "callers",
      path: "/tmp/bridge.ts",
      symbol: "callAftTool",
    });

    expect(value.symbol).toBe("callAftTool");
    expect(value.total_callers).toBe(2);
    const groups = value.callers as { file: string; callers: { symbol: string; line: number }[] }[];
    expect(groups[0]?.callers[0]).toMatchObject({ symbol: "registerOutlineTool", line: 152 });
  });

  it("call_tree：树与 resolved 标记原样进载荷", async () => {
    const response = await fixture("callgraph-call-tree.json");
    mockCallAftTool.mockResolvedValue({ text: response.text as string, response });

    const { value } = await run(registerCallgraphTool, "aft_callgraph", {
      op: "call_tree",
      path: "/tmp/path.ts",
      symbol: "resolvePathArg",
    });

    expect(value.name).toBe("resolvePathArg");
    expect(value.resolved).toBe(true);
    expect(value.children).toHaveLength(1);
  });

  it("impact：受影响调用点与参数表原样进载荷", async () => {
    const response = await fixture("callgraph-impact.json");
    mockCallAftTool.mockResolvedValue({ text: response.text as string, response });

    const { value } = await run(registerCallgraphTool, "aft_callgraph", {
      op: "impact",
      path: "/tmp/tools.ts",
      symbol: "buildZoomSubtitle",
    });

    expect(value.total_affected).toBe(2);
    expect(value.affected_files).toBe(1);
    expect(value.parameters).toEqual(["cwd", "params"]);
    const sites = value.callers as { caller_symbol: string; line: number }[];
    expect(sites[0]).toMatchObject({ caller_symbol: "registerZoomTool", line: 237 });
  });
});

describe("aft_search 结构化结果", () => {
  beforeEach(() => mockCallAftTool.mockReset());

  it("命中列表原样进载荷，两种条目形状都在", async () => {
    const response = await fixture("search-hybrid.json");
    mockCallAftTool.mockResolvedValue({ text: response.text as string, response });

    const { value } = await run(registerSearchTool, "aft_search", { query: "greet" });

    expect(value.result_count).toBe(2);
    expect(value.semantic_status).toBe("external");
    const hits = value.results as Record<string, unknown>[];
    expect(hits[0]).toMatchObject({ file: "src/a.ts", name: "greet", start_line: 1, score: 0.97 });
    expect(hits[1]).toMatchObject({ kind: "GrepLine", line: 12, line_text: "call greet here" });
  });
});

describe("schema 的宽松度", () => {
  beforeEach(() => mockCallAftTool.mockReset());

  it("引擎加了新字段照样通过复核（额外字段原样透传）", async () => {
    const response = await fixture("zoom-greet.json");
    const withNewFields = {
      ...response,
      brand_new_field: { nested: [1, 2, 3] },
      another: "value",
    };
    mockCallAftTool.mockResolvedValue({ text: response.text as string, response: withNewFields });

    const { value } = await run(registerZoomTool, "aft_zoom", {
      path: "/tmp/a.ts",
      symbols: "greet",
    });

    expect(value.brand_new_field).toEqual({ nested: [1, 2, 3] });
    expect(value.another).toBe("value");
  });
});
