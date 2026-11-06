import { type TUnsafe, Type } from "typebox";

/**
 * 固定取值的字符串参数：产出 `{ type: "string", enum: [...] }`。
 *
 * 不用 `Type.Union` + `Type.Literal`：那样会变成 `anyOf` + `const`，部分 provider 不支持这种
 * 组合（pi-ai 的 `StringEnum()` 存在就是为了避开它）。这里只保留它的 JSON 形状，schema 本身
 * 仍是 TypeBox 的，静态类型与 `Type.Optional()` 的可选性都不会丢。
 */
export function stringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description !== undefined && { description: options.description }),
    ...(options?.default !== undefined && { default: options.default }),
  });
}
