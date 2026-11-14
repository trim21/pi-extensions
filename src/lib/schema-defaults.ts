/**
 * 工具参数默认值的类型推断。
 *
 * TypeBox 的 `Static<T>` 只有输入类型一档：`default` 是注解，带默认值的字段永远是
 * `T | undefined`。总线在 `parseToolArguments` 里已经用 `Value.Default` 补值，类型却
 * 不知道，于是每个默认值都要在 handler 里再写一次 `?? 常量`。
 *
 * 这里补上缺的那一档：
 * - `Default(schema, value)` 把默认值写进 schema，并在类型上保留它的字面量（TypeBox 的
 *   builder 会把 options 从类型里丢掉，所以不能写 `Type.Boolean({ default: true })`）。
 * - `StaticDefaulted<T>` 是 `Value.Default` 补过默认值之后的类型：带默认值的字段必填，递归
 *   object / array / `anyOf`，其余落回 `Static<T>`。总线用它给 `execute` 的参数定型。
 *
 * 上游背景：typebox#1035 / #1142 / #1134 / #1581 都是这个需求，结论是 by design；官方绕法
 * `Type.Options` 在 1.3.0 被移除，所以这里自建等价物。
 */

import { type Static, type TSchema, Type } from "typebox";

/**
 * 带默认值的参数 schema：`default` 同时存在于运行期 schema 与 TypeScript 类型上，并且自带
 * TypeBox 的可选标记——有默认值就意味着调用方可以省略，不需要再套一层 `Type.Optional`。
 */
export type TDefaulted<T extends TSchema, V> = T & {
  readonly default: V;
  readonly "~optional": true;
};

export function Default<T extends TSchema, const V>(schema: T, value: V): TDefaulted<T, V> {
  return Type.Optional({ ...schema, default: value }) as TDefaulted<T, V>;
}

type HasDefault<T> = T extends { readonly default: unknown } ? true : false;

/** TypeBox 1.x 的可选标记（`Type.Optional` 加在类型上的字符串键）。 */
type IsOptionalProperty<T> = T extends { readonly "~optional": true } ? true : false;

type ResolveProperties<P extends Record<string, TSchema>> = {
  -readonly [
    K in keyof P as HasDefault<P[K]> extends true
      ? K
      : IsOptionalProperty<P[K]> extends true
        ? never
        : K
  ]-?: StaticDefaulted<P[K]>;
} & {
  -readonly [
    K in keyof P as HasDefault<P[K]> extends true
      ? never
      : IsOptionalProperty<P[K]> extends true
        ? K
        : never
  ]?: StaticDefaulted<P[K]>;
};

/**
 * `Value.Default` 补过默认值之后的参数类型：带默认值的字段必填，没有默认值的可选字段仍可选；
 * 嵌套对象、数组元素与 `anyOf` 分支递归处理，其它形状落回 `Static<T>`。
 */
export type StaticDefaulted<T> = T extends TSchema
  ? T extends { type: "object"; properties: infer P }
    ? P extends Record<string, TSchema>
      ? ResolveProperties<P>
      : never
    : T extends { type: "array"; items: infer I }
      ? I extends TSchema
        ? StaticDefaulted<I>[]
        : never
      : T extends { anyOf: infer U }
        ? U extends readonly TSchema[]
          ? StaticDefaulted<U[number]>
          : never
        : Static<T>
  : never;
