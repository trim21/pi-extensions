import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { renderType } from "../src/codemode/declarations.js";
import { createToolBus } from "../src/lib/tool-bus.js";
import { booleanParam, toOutputJsonSchema, toParametersJsonSchema } from "../src/lib/zod-tool.js";

const ctx = { cwd: "/tmp" } as unknown as ExtensionToolContext;

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

const demoParameters = z.object({
  text: z.string().describe("Text to echo"),
  times: z.number().min(1).max(5).default(1).describe("How many times"),
  mode: z.enum(["plain", "loud"]).default("plain"),
});

function registerDemo(
  bus: ReturnType<typeof createToolBus>,
  execute: (params: z.output<typeof demoParameters>) => unknown,
) {
  return bus.register({
    name: "demo",
    label: "Demo",
    description: "echo text",
    parameters: demoParameters,
    execute: async (_id, params) => ({
      content: [{ type: "text", text: JSON.stringify(execute(params)) }],
      details: {},
    }),
  });
}

describe("Zod schema 的 JSON Schema 派生", () => {
  it("参数形态：带 default，带默认值的字段不进 required", () => {
    const schema = toParametersJsonSchema(demoParameters) as unknown as {
      $schema?: unknown;
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };

    expect(schema.$schema).toBeUndefined();
    expect(schema.required).toEqual(["text"]);
    expect(schema.properties.times).toMatchObject({ default: 1, minimum: 1, maximum: 5 });
    expect(schema.properties.mode).toMatchObject({ default: "plain", enum: ["plain", "loud"] });
    expect(schema.properties.text).toMatchObject({ description: "Text to echo" });
  });

  it("输出形态：带默认值的字段进 required", () => {
    const schema = toOutputJsonSchema(demoParameters) as unknown as { required: string[] };
    expect(schema.required).toEqual(["text", "times", "mode"]);
  });

  it("派生出的 schema 能渲染成 codemode 声明", () => {
    const declaration = renderType(toParametersJsonSchema(demoParameters), "");
    expect(declaration).toContain("@default 1");
    expect(declaration).toContain("@minimum 1");
    expect(declaration).toContain("@maximum 5");
  });
});

describe("总线注册 Zod 参数的工具", () => {
  it("交给 pi 的是派生 JSON Schema，不是 Zod 对象", () => {
    const { pi, registered } = createFakePi();
    const bus = createToolBus(pi);

    expect(registerDemo(bus, () => "ok")).toBe(true);

    const parameters = registered.get("demo")?.parameters as unknown as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(parameters.type).toBe("object");
    expect(parameters.properties?.times).toMatchObject({ default: 1 });
  });

  it("省略带默认值的参数时 handler 收到默认值，显式传值时默认值不覆盖", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    const execute = vi.fn((params: z.output<typeof demoParameters>) => params);
    registerDemo(bus, execute);

    await bus.executeTool("demo", { text: "a" }, { ctx });
    expect(execute.mock.calls[0]?.[0]).toEqual({ text: "a", times: 1, mode: "plain" });

    await bus.executeTool("demo", { text: "a", times: 3, mode: "loud" }, { ctx });
    expect(execute.mock.calls[1]?.[0]).toEqual({ text: "a", times: 3, mode: "loud" });
  });

  it("越界参数被拒绝，错误里带字段路径且工具不被执行", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    const execute = vi.fn((params: z.output<typeof demoParameters>) => params);
    registerDemo(bus, execute);

    const result = await bus.executeTool("demo", { text: "a", times: 9 }, { ctx });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("times") });
    expect(execute).not.toHaveBeenCalled();
  });

  it("codemode 路径同样补默认值，并按派生 schema 复核结构化结果", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    bus.registerCodemodeOnly({
      name: "scripted",
      label: "Scripted",
      description: "scripted demo",
      parameters: demoParameters,
      structuredSchema: z.object({ times: z.number().int() }),
      execute: async (_id, params) => ({ ok: true as const, value: { times: params.times } }),
    });

    expect(await bus.executeCodemodeTool("scripted", { text: "a" }, { ctx })).toEqual({
      ok: true,
      value: { times: 1 },
    });
    expect(await bus.executeCodemodeTool("scripted", { text: "a", times: 4 }, { ctx })).toEqual({
      ok: true,
      value: { times: 4 },
    });
  });

  it("结构化结果不符 schema 时总线报错", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    bus.registerCodemodeOnly({
      name: "scripted",
      label: "Scripted",
      description: "scripted demo",
      parameters: demoParameters,
      structuredSchema: z.object({ times: z.number().int() }),
      execute: async () => ({ ok: true as const, value: { times: "many" } }) as never,
    });

    expect(await bus.executeCodemodeTool("scripted", { text: "a" }, { ctx })).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not match its structuredSchema"),
    });
  });
});

describe("参数 schema 自己承担模型的字符串写法", () => {
  const looseParameters = z.object({
    count: z.coerce.number().int().min(1),
    flag: booleanParam(),
    defaulted: booleanParam({ default: true }),
    label: z.union([z.number(), z.string()]),
  });

  function registerLoose(
    bus: ReturnType<typeof createToolBus>,
    execute: (params: z.output<typeof looseParameters>) => unknown,
  ) {
    return bus.register({
      name: "loose",
      label: "Loose",
      description: "coercion demo",
      parameters: looseParameters,
      execute: async (_id, params) => ({
        content: [{ type: "text", text: JSON.stringify(execute(params)) }],
        details: {},
      }),
    });
  }

  it("数字与布尔的字符串写法被转换后交给 handler", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    const execute = vi.fn((params: z.output<typeof looseParameters>) => params);
    registerLoose(bus, execute);

    await bus.executeTool("loose", { count: "42", flag: "false", label: "4" }, { ctx });
    expect(execute.mock.calls[0]?.[0]).toEqual({
      count: 42,
      flag: false,
      defaulted: true,
      label: "4",
    });

    await bus.executeTool("loose", { count: "7", flag: "TRUE", defaulted: "0", label: 4 }, { ctx });
    expect(execute.mock.calls[1]?.[0]).toEqual({
      count: 7,
      flag: true,
      defaulted: false,
      label: 4,
    });
  });

  it("派生出的 JSON Schema 仍是 integer / boolean，且带上默认值", () => {
    const schema = toParametersJsonSchema(looseParameters) as unknown as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(schema.properties.count).toMatchObject({ type: "integer", minimum: 1 });
    expect(schema.properties.flag).toMatchObject({ type: "boolean" });
    expect(schema.properties.defaulted).toMatchObject({ type: "boolean", default: true });
  });

  it("只认 true/false/1/0/on/off，yes / no 与其它字符串都不当布尔", () => {
    for (const value of ["yes", "no", "maybe", " off "]) {
      expect(booleanParam().safeParse(value).success).toBe(false);
    }
    for (const value of ["true", "FALSE", "1", "0", "on", "OFF", "On"]) {
      expect(booleanParam().parse(value)).toBe(["true", "1", "on"].includes(value.toLowerCase()));
    }
  });

  it("转不了的值交给 Zod 报错，工具不被执行", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    const execute = vi.fn((params: z.output<typeof looseParameters>) => params);
    registerLoose(bus, execute);

    const result = await bus.executeTool(
      "loose",
      { count: "abc", flag: "maybe", label: 1 },
      { ctx },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("count") });
    expect(execute).not.toHaveBeenCalled();
  });

  it("pi 侧拿到的 prepareArguments 同样转换", () => {
    const { pi, registered } = createFakePi();
    const bus = createToolBus(pi);
    registerLoose(bus, () => "ok");

    const prepare = registered.get("loose")?.prepareArguments;
    expect(prepare?.({ count: "3", flag: "false", label: 1 })).toEqual({
      count: 3,
      flag: false,
      defaulted: true,
      label: 1,
    });
  });
});

describe("TypeBox 工具不受影响", () => {
  it("仍走 Value.Convert + Value.Default", async () => {
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    const execute = vi.fn(async (_id: string, params: { count: number }) => ({
      content: [{ type: "text" as const, text: String(params.count) }],
      details: {},
    }));

    bus.register({
      name: "typebox",
      label: "TypeBox",
      description: "typebox demo",
      parameters: Type.Object({
        count: Type.Integer({ minimum: 1, maximum: 5, default: 2 }),
      }),
      execute,
    });

    await bus.executeTool("typebox", {}, { ctx });
    expect(execute.mock.calls[0]?.[1]).toEqual({ count: 2 });

    // TypeBox 分支仍由 Value.Convert 转换；Zod 分支的容错落在参数 schema 自己身上
    await bus.executeTool("typebox", { count: "4" }, { ctx });
    expect(execute.mock.calls[1]?.[1]).toEqual({ count: 4 });
  });
});
