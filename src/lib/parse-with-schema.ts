import type { Static, TSchema } from "typebox";
import Value, { ParseError } from "typebox/value";

/**
 * 用 typebox schema 解析 value。成功返回解析结果；失败抛带字段路径的 Error
 * （Value.Parse 的 ParseError 错误详情在 cause.errors，默认 message 只有
 * "Parse"，这里拼成可读信息，供调用方包装上下文如配置文件路径）。
 */
export function parseWithSchema<T extends TSchema>(schema: T, value: unknown): Static<T> {
  try {
    return Value.Parse(schema, value);
  } catch (error) {
    if (error instanceof ParseError) {
      const details = error.cause.errors
        .map((e) => `${e.instancePath || "(root)"}: ${e.message}`)
        .join("; ");
      throw new Error(details, { cause: error });
    }
    throw error;
  }
}
