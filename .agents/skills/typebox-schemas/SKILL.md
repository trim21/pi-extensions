---
name: typebox-schemas
description: Use when adding or editing a pi tool's TypeBox parameter or structured-output schema in this repository, when a schema field, default, or description is missing from the model's context, or when a tool handler's params type has drifted from its schema.
---

# TypeBox schema 在本仓库的三条通路

同一个 schema 被三处消费，行为各不相同。改 schema 前先确认它走哪条通路。

| 消费点                                 | 模型看得到什么                                                                                                                                                | 应用 `default`                       | 位置                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| pi 工具（`bus.register`）              | 整个 JSON Schema：字段名、`required`、`description`、`default`、`enum` 都随 provider 请求进上下文                                                             | 否                                   | 注册在 `src/lib/tool-bus.ts`；pi 侧用 pi-schema 校验 |
| codemode（`bus.registerCodemodeOnly`） | 工具描述渲染成 `call()` 的 JSDoc；字段的 `description` 与 `default`（`@default <JSON>`）渲染成字段 JSDoc，其它注解（`minimum`、`pattern`、`format` 等）不渲染 | 否                                   | `src/codemode/declarations.ts`                       |
| 工具总线解析                           | 校验后的值，缺省字段已按 schema 的 `default` 补齐                                                                                                             | 是（`Value.Default`，在 Parse 之前） | `src/lib/tool-bus.ts` 的 `parseToolArguments`        |

## 解析：怎么执行、失败长什么样

`parseToolArguments`（`src/lib/tool-bus.ts:207`）= `parseWithSchema(schema, Value.Default(schema, Value.Convert(schema, value)))`：

1. `Value.Convert` 按 schema 强转类型（`"5"` → `5`），模型给的宽松 JSON 不会因为类型不符直接失败。
2. `Value.Default` 用 schema 上的 `default` 补齐缺失字段。它原地修改传入对象——pi 路径传的是 pi clone 过的参数，codemode 路径是 JSON 解析出的新对象，改它们不影响调用方。
3. `parseWithSchema`（`src/lib/parse-with-schema.ts`）走 `Value.Parse` 校验，失败把 `ParseError` 拼成 `instancePath: message; ...` 抛出。默认值必须在 Parse 之前补：补进去的值也要过校验，`default` 写错类型不会被静默接受。
4. 总线把异常包成 `Invalid arguments for tool "X": ...`，工具不会执行。两条执行路径都一样：`executeTool`（pi 工具，`tool-bus.ts:387`）与 `executeCodemodeTool`（codemode，`tool-bus.ts:429`）都在调用 handler 前走它。

pi 在调用扩展工具前还会用自己的 pi-schema coerce validator 校验一次（pi 仓库 `packages/ai/src/utils/validation.ts`），但 pi-schema 明确写了 `default` 只是注解、校验不会插入它（pi 仓库 `packages/schema/src/builders.ts:33`）。补 `default` 的是工具总线，不是 pi。

## 解析之后拿到什么

handler 的 `params` 是 `Static<typeof schema>`：`Type.Optional` → `| undefined`，`Type.Union` → 联合类型，`Type.Literal` / `Type.StringEnum` → 字面量，`Type.Array` → 数组。运行期缺省字段已被 `Value.Default` 补齐，但 `Static` 不追踪 `default`，类型上仍是 `| undefined`。

参数类型 MUST 从 schema 推断，不要另写 interface：

```ts
// src/gh/schemas.ts —— schema 是唯一来源
export const waitPrChecksParameters = Type.Object({
  number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
  repo: checksWaitRepoSchema,
  fail_fast: checksWaitFailFastSchema,
});

// src/gh/tools/wait-pr-checks.ts
type PrChecksWaitParams = Static<typeof waitPrChecksParameters>;

bus.registerCodemodeOnly({ parameters: waitPrChecksParameters /* ... */ });
```

手写 interface + 内联 schema 会漂移（改一处漏一处）：schema 提成模块级 const，注册时传它，handler 类型用 `Static`。

## 默认值：schema 声明 + 代码类型收窄

`Type.Optional(...)` 决定字段能否省略，`default` 提供缺省值，两者都要：

```ts
// src/gh/schemas.ts
export const CHECKS_WAIT_FAIL_FAST_DEFAULT = true;

const checksWaitFailFastSchema = Type.Optional(
  Type.Boolean({
    default: CHECKS_WAIT_FAIL_FAST_DEFAULT,
    description: "Exit immediately when any check fails; false waits for the remaining checks",
  }),
);

// handler 里：运行期总线已经补过值，?? 只为把类型从 boolean | undefined 收窄
failFast: fail_fast ?? CHECKS_WAIT_FAIL_FAST_DEFAULT,
```

`default` 与常量是同一个值：schema 负责把默认值送进上下文（pi 侧是 JSON Schema，codemode 侧是 `@default` tag），总线负责在解析前补值，代码里的 `??` 只剩类型收窄作用。不要在描述文本里重复默认值，也不要在代码里写 `?? true` 这类字面量。

## 进上下文的写法

- **直接工具**：字段级 `description` / `default` / `enum` 随 JSON Schema 原样进模型；根级 `anyOf` 之类在 Anthropic 的非 strict 路径会被裁掉，别把关键信息放根级。
- **codemode-only 工具**：模型看不到 JSON Schema，只看到 `renderDeclarations` 生成的 TS 声明，嵌在 codemode 工具描述里（`src/codemode/tool.ts:131`）。`declarations.ts` 把字段的 `description` 和 `default` 渲染成 JSDoc（单行 `/** ... */`，多行块注释，`default` 是 `@default <JSON>` 一行）；`minimum` / `maximum` / `pattern` / `format` 等其它注解不渲染，这类约束和互斥关系要写进 `description` 文本。
- 渲染器只支持 object / array / string / number / boolean / const / union / enum（`src/codemode/declarations.ts:50`），其它形状退化成 `unknown`，等于没给类型。

## 输出 schema

`structuredSchema` 描述返回载荷：声明了它就必须返回 `structuredResult`，总线用 `parseWithSchema` 复核（`checkStructuredResult`），codemode 脚本拿到的 `Promise<T>` 也来自它。外部数据（REST 响应）允许额外字段，不要加 `additionalProperties: false`；只描述工具真正依赖的字段，内部构造的载荷才可以收紧。

## 常见错误

| 现象                              | 原因                            | 修法                                                     |
| --------------------------------- | ------------------------------- | -------------------------------------------------------- |
| 模型不知道默认值                  | schema 没写 `default`           | 在 schema 上写 `default`（codemode 会渲染成 `@default`） |
| 省略参数后类型仍是 `\| undefined` | `Static` 不追踪 `default`       | `?? CONSTANT` 收窄类型（运行期总线已补值）               |
| 改了 schema 但 handler 类型没变   | 手写 interface 与 schema 各一份 | `type X = Static<typeof schema>`                         |
| 校验报错只有 `Parse`              | 直接调了 `Value.Parse`          | 用 `parseWithSchema`                                     |
| codemode 里参数类型是 `unknown`   | schema 用了渲染器不支持的形状   | 换成受支持的形状                                         |

> 本 skill 放在 `.agents/skills/`，只用于本仓库开发，不注册进 `package.json` 的 `pi.skills`。
