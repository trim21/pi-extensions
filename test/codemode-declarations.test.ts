import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { renderType } from "../src/codemode/declarations.js";

describe("renderType", () => {
  it("渲染对象、数组与字段说明", () => {
    const schema = Type.Object({
      name: Type.String({ description: "single line" }),
      count: Type.Number(),
      tags: Type.Array(Type.String()),
      nested: Type.Object({
        inner: Type.Boolean(),
        deep: Type.Array(Type.Number(), { description: "数组自身的说明" }),
      }),
      note: Type.Optional(Type.String({ description: "first line\nsecond line" })),
    });

    expect(renderType(schema, "")).toMatchInlineSnapshot(`
      "{
        // single line
        name: string;
        count: number;
        tags: Array<string>;
        nested: {
          inner: boolean;
          // 数组自身的说明
          deep: Array<number>;
        };
        /**
         * first line
         * second line
         */
        note?: string;
      }"
    `);
  });

  it("渲染联合、字面量与无法识别的回退", () => {
    const schema = Type.Object({
      kind: Type.Union([Type.Literal("a"), Type.Literal("b")]),
      nullable: Type.Union([Type.String(), Type.Null()]),
      anything: Type.Unknown(),
      empty: Type.Object({}),
    });

    expect(renderType(schema, "")).toMatchInlineSnapshot(`
      "{
        kind: "a" | "b";
        nullable: string | null;
        anything: unknown;
        empty: Record<string, unknown>;
      }"
    `);
  });

  it("按传入缩进渲染嵌套对象", () => {
    const schema = Type.Object({ outer: Type.Object({ inner: Type.String() }) });

    expect(renderType(schema, "  ")).toMatchInlineSnapshot(`
      "{
          outer: {
            inner: string;
          };
        }"
    `);
  });
});
