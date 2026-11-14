import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import { Default, type StaticDefaulted } from "../src/lib/schema-defaults.js";
import { createToolBus } from "../src/lib/tool-bus.js";

const ctx = { cwd: "/tmp" } as unknown as ExtensionToolContext;

const parameters = Type.Object({
  name: Type.String(),
  count: Default(Type.Number(), 3),
  nested: Type.Object({ flag: Default(Type.Boolean(), true) }),
  list: Type.Array(Type.Object({ tag: Default(Type.String(), "x") })),
});

type Params = StaticDefaulted<typeof parameters>;

// 类型层断言：由 `pnpm check`（tsc --noEmit）验证，运行时只占位。
const fullySpecified: Params = {
  name: "a",
  count: 1,
  nested: { flag: false },
  list: [{ tag: "y" }],
};
// @ts-expect-error count 有默认值，解析后必有
const missingCount: Params = { name: "a", nested: { flag: true }, list: [] };
// @ts-expect-error nested.flag 有默认值，解析后必有
const missingNestedDefault: Params = { name: "a", count: 1, nested: {}, list: [] };
// @ts-expect-error list 元素的 tag 有默认值，解析后必有
const missingListDefault: Params = { name: "a", count: 1, nested: { flag: true }, list: [{}] };
// @ts-expect-error name 没有默认值，仍然必填
const missingName: Params = { count: 1, nested: { flag: true }, list: [] };

const optionalOnly = Type.Object({ maybe: Type.Optional(Type.String()) });
// 没有默认值的可选字段解析后仍是可选的
const withoutOptional: StaticDefaulted<typeof optionalOnly> = {};

function createFakePi() {
  const registered = new Map<string, unknown>();
  return {
    registered,
    pi: {
      registerTool: (tool: { name: string }) => {
        registered.set(tool.name, tool);
      },
    } as never,
  };
}

describe("Default", () => {
  it("把默认值写进 schema，运行期由 Value.Default 补齐", () => {
    expect(parameters.properties.count).toMatchObject({ default: 3 });
    expect(Value.Default(parameters, { name: "a", nested: {}, list: [] })).toMatchObject({
      name: "a",
      count: 3,
      nested: { flag: true },
    });
  });
});

describe("总线参数类型", () => {
  it("registerCodemodeOnly 的脚本路径补默认值", async () => {
    const execute = vi.fn(async (_id: string, params: Params) => ({
      ok: true as const,
      value: params,
    }));
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    bus.registerCodemodeOnly({
      name: "defaulted",
      label: "Defaulted",
      description: "defaulted params",
      parameters,
      structuredSchema: parameters,
      execute,
    });

    const codemodeResult = await bus.executeCodemodeTool(
      "defaulted",
      { name: "a", nested: {}, list: [] },
      { ctx },
    );

    const expected = { name: "a", count: 3, nested: { flag: true }, list: [] };
    expect(execute.mock.calls[0]?.[1]).toEqual(expected);
    expect(codemodeResult).toEqual({ ok: true, value: expected });
  });

  it("register 的 pi 工具路径同样补默认值", async () => {
    const execute = vi.fn(async (_id: string, params: Params) => ({
      content: [{ type: "text" as const, text: params.name }],
      details: {},
    }));
    const { pi } = createFakePi();
    const bus = createToolBus(pi);
    bus.register({
      name: "defaulted",
      label: "Defaulted",
      description: "defaulted params",
      parameters,
      execute,
    });

    const result = await bus.executeTool("defaulted", { name: "a", nested: {}, list: [] }, { ctx });

    expect(execute.mock.calls[0]?.[1]).toEqual({
      name: "a",
      count: 3,
      nested: { flag: true },
      list: [],
    });
    expect(result.isError).toBe(false);
  });
});

// 未使用的类型层样本：保留它们让 tsc 校验上面的断言
void [
  optionalOnly,
  fullySpecified,
  missingCount,
  missingNestedDefault,
  missingListDefault,
  missingName,
  withoutOptional,
];
