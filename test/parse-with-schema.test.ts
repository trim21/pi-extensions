import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { parseWithSchema } from "../src/lib/parse-with-schema.js";

const schema = Type.Object({
  mode: Type.Union([Type.Literal("allow-all"), Type.Literal("workspace-write")]),
  approvalRules: Type.Optional(
    Type.Array(
      Type.Object({
        action: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
        pattern: Type.String(),
      }),
    ),
  ),
});

describe("parseWithSchema", () => {
  it("returns the parsed value for valid input", () => {
    const input = { mode: "allow-all" };
    expect(parseWithSchema(schema, input)).toEqual(input);
  });

  it("tolerates unknown fields by default", () => {
    const input = { mode: "allow-all", futureField: 1 };
    expect(parseWithSchema(schema, input)).toEqual(input);
  });

  it("throws with the field path on a type error", () => {
    expect(() => parseWithSchema(schema, { mode: "unsafe" })).toThrowErrorMatchingInlineSnapshot(
      `[Error: /mode: must be equal to constant; /mode: must be equal to constant; /mode: must match a schema in anyOf]`,
    );
  });

  it("throws with the nested field path on an array member error", () => {
    expect(() =>
      parseWithSchema(schema, {
        mode: "allow-all",
        approvalRules: [{ action: "allow", pattern: 42 }],
      }),
    ).toThrowErrorMatchingInlineSnapshot(`[Error: /approvalRules/0/pattern: must be string]`);
  });

  it("names extra fields when additionalProperties is false", () => {
    const strict = Type.Object(
      { mode: Type.Literal("allow-all") },
      { additionalProperties: false },
    );
    expect(() => parseWithSchema(strict, { mode: "allow-all", extra: 1 })).toThrow(
      /must not have additional properties/,
    );
  });
});
