/**
 * Zod schema 的桥接层：工具直接用 Zod 声明 `parameters` / `structuredSchema`，总线在注册时
 * 把 Zod schema 派生为 JSON Schema 交给 pi 与 codemode 声明渲染器，并把参数解析交给
 * `prepareArguments`（Zod 的 `parse`）。运行期的默认值、边界与错误信息都来自 Zod。
 *
 * 派生出的 JSON Schema 没有 TypeBox 的类型标记，因此 `Value.Default` / `Value.Convert` 对它
 * 是空操作；这不成问题——Zod 在 `prepareArguments` 里已经补过默认值、做完了校验。
 */

import type { TSchema } from "typebox";
import { z } from "zod";

import type { StructuredResult } from "./tool-bus.js";

/** 工具参数必须是对象 schema：pi 与 codemode 的声明都是 `{ type: "object", ... }`。 */
export type ZodToolSchema = z.ZodObject<z.ZodRawShape>;

const stringBoolean = z.stringbool({ truthy: ["true", "1", "on"], falsy: ["false", "0", "off"] });

/**
 * 布尔参数：接受真布尔，也接受字符串写法 `true` / `false` / `1` / `0` / `on` / `off`
 * （大小写不敏感，不做 trim）。
 *
 * 不认 `yes` / `no`：`no` 同时是挪威的国家代码（Norway problem），把这类字符串当布尔会
 * 静默改值。也不用 `z.coerce.boolean()`：它是 `Boolean(input)`，`"false"` 会得到 `true`，
 * 任何没见过的字符串都会变成 `true`——对 `dangerouslyDisableSandbox` 这类开关等于静默提权。
 *
 * 派生出的 JSON Schema 仍是 `type: "boolean"`：字符串写法是容错，不是给模型的接口。
 * 默认值必须交给本函数（落在内层 `z.boolean()` 上），写在返回值上的 `.default()` 不会
 * 出现在派生的 JSON Schema 里。
 */
export function booleanParam(options: { default?: boolean } = {}) {
  const inner = options.default === undefined ? z.boolean() : z.boolean().default(options.default);
  return z.preprocess((value: unknown) => {
    const parsed = stringBoolean.safeParse(value);
    return parsed.success ? parsed.data : value;
  }, inner);
}

/** 结构化成功结果：载荷按 Zod schema 解析后返回（解析失败就是工具实现的问题，直接抛）。 */
export function zodStructuredResult<T extends z.ZodType>(
  schema: T,
  value: unknown,
): StructuredResult<z.output<T>> {
  return { ok: true, value: schema.parse(value) };
}

/**
 * 参数形态的 JSON Schema：带 `default`，带默认值的字段不进 `required`——调用方可以省略，
 * 省略后由 Zod 补值。
 */
export function toParametersJsonSchema(schema: ZodToolSchema): TSchema {
  return toJsonSchema(schema, "input");
}

/** 输出形态的 JSON Schema：带默认值的字段一定出现在返回值里，因此进 `required`。 */
export function toOutputJsonSchema(schema: z.ZodType): TSchema {
  return toJsonSchema(schema, "output");
}

function toJsonSchema(schema: z.ZodType, io: "input" | "output"): TSchema {
  const json: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { io, target: "draft-2020-12", unrepresentable: "throw" }),
  };
  // 与 TypeBox schema 同形：pi 与 codemode 渲染器都不需要 draft 标记
  delete json.$schema;
  return json;
}
