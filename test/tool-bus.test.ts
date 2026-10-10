import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
  createToolBus,
  defineStructuredTool,
  type ToolExecutionResult,
} from "../src/lib/tool-bus.js";

const ctx = { cwd: "/tmp" } as unknown as ExtensionToolContext;

const echoParameters = Type.Object({ text: Type.String() });

type EchoExecute = ToolDefinition<typeof echoParameters>["execute"];

const noopExecute: EchoExecute = async () => ({
  content: [{ type: "text", text: "ok" }],
  details: {},
});

function echoTool(execute: EchoExecute = noopExecute) {
  return {
    name: "echo",
    label: "Echo",
    description: "echo text back",
    parameters: echoParameters,
    execute,
  };
}

/** 工具结果里的文本内容拼接，断言错误信息时不用关心 JSON 转义。 */
function textOf(result: ToolExecutionResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function createFakePi(): { registered: Map<string, ToolDefinition>; pi: never } {
  const registered = new Map<string, ToolDefinition>();
  return {
    registered,
    pi: {
      registerTool: (tool: ToolDefinition) => {
        registered.set(tool.name, tool);
      },
    } as never,
  };
}

describe("tool bus 注册", () => {
  it("注册通过的工具进入 pi 与总线", () => {
    const { pi, registered } = createFakePi();
    const bus = createToolBus(pi);
    const tool = echoTool();

    expect(bus.register(tool)).toBe(true);
    expect(registered.has("echo")).toBe(true);
    expect(bus.list().map((item) => item.name)).toEqual(["echo"]);
    expect(bus.get("echo")).toBe(tool);
    expect(bus.get("missing")).toBeUndefined();
  });

  it("被禁用的工具不注册，但仍算已声明", () => {
    const { pi, registered } = createFakePi();
    const bus = createToolBus(pi, { isDisabled: (name) => name === "echo" });

    expect(bus.register(echoTool())).toBe(false);
    expect(registered.size).toBe(0);
    expect(bus.list()).toEqual([]);
    expect(bus.declaredNames()).toEqual(["echo"]);
  });

  it("codemode-only 工具只留在总线，不交给 pi", () => {
    const { pi, registered } = createFakePi();
    const bus = createToolBus(pi, { isCodemodeOnly: (name) => name === "echo" });
    const tool = defineStructuredTool({
      name: "echo",
      label: "Echo",
      description: "echo text back",
      parameters: echoParameters,
      structuredSchema: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => ({
        content: [{ type: "text", text: params.text }],
        details: {},
        structuredResult: { ok: true, value: { text: params.text } },
      }),
    });

    expect(bus.register(tool)).toBe(true);
    expect(registered.has("echo")).toBe(false);
    expect(bus.list().map((item) => item.name)).toEqual(["echo"]);
    expect(bus.get("echo")?.codemodeOnly).toBe(true);
    expect(bus.diagnostics()).toEqual([]);
  });

  it("codemode-only 命中但没有结构化输出时照常交给 pi，并给出诊断", () => {
    const { pi, registered } = createFakePi();
    const bus = createToolBus(pi, { isCodemodeOnly: (name) => name === "echo" });

    expect(bus.register(echoTool())).toBe(true);
    expect(registered.has("echo")).toBe(true);
    expect(bus.get("echo")?.codemodeOnly).toBeUndefined();
    expect(bus.diagnostics()).toEqual([
      'personalExtensions.codemodeOnlyTools: tool "echo" declares no structuredSchema; it stays directly available.',
    ]);
  });

  it("禁用优先于 codemode-only：两端都不注册且无诊断", () => {
    const { pi, registered } = createFakePi();
    const bus = createToolBus(pi, {
      isDisabled: (name) => name === "echo",
      isCodemodeOnly: (name) => name === "echo",
    });

    expect(bus.register(echoTool())).toBe(false);
    expect(registered.size).toBe(0);
    expect(bus.list()).toEqual([]);
    expect(bus.diagnostics()).toEqual([]);
  });
});

describe("tool bus 执行", () => {
  it("校验参数后执行，并透传 ctx / signal / toolCallId", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    const execute = vi.fn(
      async (toolCallId: string, params: { text: string }, ...rest: unknown[]) => ({
        content: [{ type: "text" as const, text: `${toolCallId}:${params.text}` }],
        details: { params, rest },
      }),
    );
    bus.register(echoTool(execute));
    const signal = new AbortController().signal;

    const result = await bus.executeTool(
      "echo",
      { text: "hi" },
      { ctx, signal, toolCallId: "call-1" },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "call-1:hi" }]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe("call-1");
    expect(execute.mock.calls[0]?.[2]).toBe(signal);
    expect(execute.mock.calls[0]?.[4]).toBe(ctx);
  });

  it("缺省生成 toolCallId", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    const execute = vi.fn(async (toolCallId: string) => ({
      content: [{ type: "text" as const, text: toolCallId }],
      details: {},
    }));
    bus.register(echoTool(execute));

    const first = await bus.executeTool("echo", { text: "a" }, { ctx });
    const second = await bus.executeTool("echo", { text: "b" }, { ctx });

    expect(execute.mock.calls[0]?.[0]).toMatch(/^tool-bus-\d+$/);
    expect(execute.mock.calls[0]?.[0]).not.toBe(execute.mock.calls[1]?.[0]);
    expect(first.content).not.toEqual(second.content);
  });

  it("参数不合法时返回错误结果且不执行工具", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    const execute = vi.fn(noopExecute);
    bus.register(echoTool(execute));

    const result = await bus.executeTool("echo", { text: 42 }, { ctx });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid arguments for tool "echo"');
    expect(execute).not.toHaveBeenCalled();
  });

  it("工具抛错时返回错误结果", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    bus.register(
      echoTool(async () => {
        throw new Error("boom");
      }),
    );

    const result = await bus.executeTool("echo", { text: "hi" }, { ctx });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("boom");
  });

  it("未知工具名返回错误结果", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);

    const result = await bus.executeTool("nope", {}, { ctx });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not available");
  });

  it("执行前调用 prepareArguments", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    const execute = vi.fn(async (_id: string, params: { text: string }) => ({
      content: [{ type: "text" as const, text: params.text }],
      details: {},
    }));
    bus.register({
      ...echoTool(execute),
      prepareArguments: (args) => ({ text: String((args as { value: number }).value) }),
    });

    const result = await bus.executeTool("echo", { value: 7 }, { ctx });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "7" }]);
  });

  it("executeTool 能执行 codemode-only 工具", async () => {
    const { pi, registered } = createFakePi();
    const bus = createToolBus(pi, { isCodemodeOnly: (name) => name === "echo" });
    bus.register(
      defineStructuredTool({
        name: "echo",
        label: "Echo",
        description: "echo text back",
        parameters: echoParameters,
        structuredSchema: Type.Object({ text: Type.String() }),
        execute: async (_id, params) => ({
          content: [{ type: "text", text: params.text }],
          details: {},
          structuredResult: { ok: true, value: { text: params.text } },
        }),
      }),
    );

    const result = await bus.executeTool("echo", { text: "hi" }, { ctx });

    expect(result.isError).toBe(false);
    expect(result.structuredResult).toEqual({ ok: true, value: { text: "hi" } });
    expect(registered.has("echo")).toBe(false);
  });
});
