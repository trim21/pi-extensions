---
name: typebox-schemas
description: Use when adding or editing a pi tool's TypeBox parameter or structured-output schema in this repository, when a schema field, default, or description is missing from the model's context, or when a tool handler's params type has drifted from its schema.
---

# TypeBox schema 在本仓库的三条通路

同一个 schema 被三处消费，行为各不相同。改 schema 前先确认它走哪条通路。

| 消费点                                 | 模型看得到什么                                                                                                                                                                   | 应用 `default`                       | 位置                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| pi 工具（`bus.register`）              | 整个 JSON Schema：字段名、`required`、`description`、`default`、`enum` 都随 provider 请求进上下文                                                                                | 否                                   | 注册在 `src/lib/tool-bus.ts`；pi 侧用 pi-schema 校验 |
| codemode（`bus.registerCodemodeOnly`） | 工具描述渲染成 `call()` 的 JSDoc；字段的 `description`、`default`（`@default <JSON>`）与数值/长度边界（`@minimum`、`@maximum` 等）渲染成字段 JSDoc，`pattern`、`format` 等不渲染 | 否                                   | `src/codemode/declarations.ts`                       |
| 工具总线解析                           | 校验后的值，缺省字段已按 schema 的 `default` 补齐                                                                                                                                | 是（`Value.Default`，在 Parse 之前） | `src/lib/tool-bus.ts` 的 `parseToolArguments`        |

## 解析：怎么执行、失败长什么样

`parseToolArguments`（`src/lib/tool-bus.ts:207`）= `parseWithSchema(schema, Value.Default(schema, Value.Convert(schema, value)))`：

1. `Value.Convert` 按 schema 强转类型（`"5"` → `5`），模型给的宽松 JSON 不会因为类型不符直接失败。
2. `Value.Default` 用 schema 上的 `default` 补齐缺失字段。它原地修改传入对象——pi 路径传的是 pi clone 过的参数，codemode 路径是 JSON 解析出的新对象，改它们不影响调用方。
3. `parseWithSchema`（`src/lib/parse-with-schema.ts`）走 `Value.Parse` 校验，失败把 `ParseError` 拼成 `instancePath: message; ...` 抛出。默认值必须在 Parse 之前补：补进去的值也要过校验，`default` 写错类型不会被静默接受。
4. 总线把异常包成 `Invalid arguments for tool "X": ...`，工具不会执行。两条执行路径都一样：`executeTool`（pi 工具，`tool-bus.ts:387`）与 `executeCodemodeTool`（codemode，`tool-bus.ts:429`）都在调用 handler 前走它。

pi 在调用扩展工具前还会用自己的 pi-schema coerce validator 校验一次（pi 仓库 `packages/ai/src/utils/validation.ts`），但 pi-schema 明确写了 `default` 只是注解、校验不会插入它（pi 仓库 `packages/schema/src/builders.ts:33`）。补 `default` 的是工具总线，不是 pi。

## 解析之后拿到什么

handler 的 `params` 由总线按 `StaticDefaulted<TParams>` 定型（`src/lib/schema-defaults.ts`）：`Type.Optional` → `| undefined`，`Type.Union` → 联合类型，`Type.Literal` / `Type.StringEnum` → 字面量，`Type.Array` → 数组；用 `Default()` 声明过默认值的字段是必填（运行期 `Value.Default` 一定补上）。

参数类型 MUST 从 schema 推断，不要另写 interface：

```ts
// src/gh/schemas.ts —— schema 是唯一来源
export const waitPrChecksParameters = Type.Object({
  number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
  repo: checksWaitRepoSchema,
  fail_fast: checksWaitFailFastSchema,
});

// src/gh/tools/wait-pr-checks.ts
type PrChecksWaitParams = StaticDefaulted<typeof waitPrChecksParameters>;

bus.registerCodemodeOnly({ parameters: waitPrChecksParameters /* ... */ });
```

手写 interface + 内联 schema 会漂移（改一处漏一处）：schema 提成模块级 const，注册时传它，handler 类型用 `StaticDefaulted`。

## 默认值：`Default()` + `StaticDefaulted`

默认值 MUST 经 `Default(schema, value)` 声明——TypeBox 的 builder 会把 options 从类型里丢掉，`Type.Boolean({ default: true })` 在类型上「没有默认值」，`StaticDefaulted` 就推不出必填。`Default()` 自带 `Type.Optional`，不要再套一层（`Type.Optional(Default(...))` 是错的，optional 标记会把默认值从类型上抹掉）：

```ts
// src/gh/schemas.ts
import { Default } from "../lib/schema-defaults.js";

const checksWaitFailFastSchema = Default(
  Type.Boolean({
    description: "Exit immediately when any check fails; false waits for the remaining checks",
  }),
  true,
);

// handler 里：params.fail_fast 已经是 boolean，不需要 ?? 兜底
failFast: params.fail_fast,
```

分工：`Default()` 把默认值写进 schema（pi 侧随 JSON Schema 进上下文，codemode 侧渲染成 `@default <JSON>`）并在类型上保留；总线在 `Value.Default` 之后按 `StaticDefaulted` 给 `execute` 定型，所以 handler 不需要 `?? 常量`，也不该再写一份兜底。默认值就写在 `Default()` 的第二个参数上，不要再抽 `DEFAULT_XXX` 常量（除非 schema 之外真的还有别的使用点，比如 lib 层的上限校验）。上游背景见 `openspec/changes/infer-schema-defaults/design.md`：TypeBox 把 `default` 排除在推断之外是 by design，官方的 `Type.Options` 在 1.3.0 被移除。

## 进上下文的写法

- **直接工具**：字段级 `description` / `default` / `enum` / `minimum` / `maximum` 随 JSON Schema 原样进模型；根级 `anyOf` 之类在 Anthropic 的非 strict 路径会被裁掉，别把关键信息放根级。
- **codemode-only 工具**：模型看不到 JSON Schema，只看到 `renderDeclarations` 生成的 TS 声明，嵌在 codemode 工具描述里（`src/codemode/tool.ts:131`）。`declarations.ts` 把字段的 `description`、`default`、数值与长度边界（`minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` / `minLength` / `maxLength` / `minItems` / `maxItems`）渲染成 JSDoc tag（单行 `/** ... */`，多行块注释）；`pattern` / `format` 等仍不渲染，这类约束和互斥关系要写进 `description` 文本。**不要**把边界重复写进 `description`（`max 50` 之类），schema 上的 `maximum` 已经进 JSDoc。
- 渲染器只支持 object / array / string / number / boolean / const / union / enum（`src/codemode/declarations.ts:50`），其它形状退化成 `unknown`，等于没给类型。

## 输出 schema

`structuredSchema` 描述返回载荷：声明了它就必须返回 `structuredResult`，总线用 `parseWithSchema` 复核（`checkStructuredResult`），codemode 脚本拿到的 `Promise<T>` 也来自它。外部数据（REST 响应）允许额外字段，不要加 `additionalProperties: false`；只描述工具真正依赖的字段，内部构造的载荷才可以收紧。

## 常见错误

| 现象                              | 原因                                 | 修法                                                  |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| 模型不知道默认值                  | schema 没写 `default`                | 用 `Default(Type.X(...), value)` 声明                 |
| 省略参数后类型仍是 `\| undefined` | 默认值写成了 `Type.X({ default })`   | 用 `Default(Type.X(...), value)` 声明默认值           |
| 默认值在类型上消失                | 写成了 `Type.Optional(Default(...))` | `Default()` 自带 optional，去掉外层 `Type.Optional`   |
| 边界在 codemode 里看不见          | 只写在 `description` 文本里          | 写进 schema 的 `minimum` / `maximum` / `minLength` 等 |
| 改了 schema 但 handler 类型没变   | 手写 interface 与 schema 各一份      | `type X = Static<typeof schema>`                      |
| 校验报错只有 `Parse`              | 直接调了 `Value.Parse`               | 用 `parseWithSchema`                                  |
| codemode 里参数类型是 `unknown`   | schema 用了渲染器不支持的形状        | 换成受支持的形状                                      |

> 本 skill 放在 `.agents/skills/`，只用于本仓库开发，不注册进 `package.json` 的 `pi.skills`。
