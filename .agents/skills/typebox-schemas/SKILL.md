---
name: typebox-schemas
description: Use when adding or editing a pi tool's parameter or structured-output schema in this repository, when a schema field/default/description is missing from the model's context, or when a tool handler's params type has drifted from its schema. Tools use Zod; TypeBox remains only for non-tool schemas (config and internal parsing).
---

# 工具 schema：Zod 是工具声明的唯一方言

工具（`bus.register` / `bus.registerCodemodeOnly` / `defineStructuredTool`）的 `parameters` 与 `structuredSchema` 用 Zod 声明。TypeBox 仍存在于**非工具** schema（配置解析、协议、引擎响应等），见文末。

同一个 Zod schema 被三处消费：

| 消费点                                 | 模型看得到什么                                                                                                                                                                   | 谁补默认值                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| pi 工具（`bus.register`）              | `z.toJSONSchema` 派生出的完整 JSON Schema：字段名、`required`、`description`、`default`、`enum` 随 provider 请求进上下文                                                         | Zod（`prepareArguments`）          |
| codemode（`bus.registerCodemodeOnly`） | 工具描述渲染成 `call()` 的 JSDoc；字段的 `description`、`default`（`@default <JSON>`）与数值/长度边界（`@minimum`、`@maximum` 等）渲染成字段 JSDoc，`pattern`、`format` 等不渲染 | Zod（总线调用 `prepareArguments`） |
| 工具总线解析                           | 校验并补过默认值的参数                                                                                                                                                           | Zod                                |

## 注册时发生什么

`src/lib/tool-bus.ts` 的 `normalize()`：

1. `parameters` 是 Zod schema 时，`z.toJSONSchema(schema, { io: "input" })` 派生 JSON Schema 交给 pi 与 codemode 渲染器；`structuredSchema` 同样派生（`io: "output"`）。派生结果删掉 `$schema`，与 TypeBox 输出同形。
2. 把定义上的 `prepareArguments` 换成「先跑工具自己的 `prepareArguments`（如果有），再 `schema.parse`」。pi 在 schema 校验前调用它，总线在 `executeTool` / `executeCodemodeTool` 里也调用它。
3. 随后总线仍走 `Value.Convert → Value.Default → Parse`，但对象已是派生出的普通 JSON Schema，`Convert` / `Default` 对它没有效果，`Parse` 只做结构校验。

所以：**默认值、边界、错误信息都来自 Zod**，不需要 `Default()` / `StaticDefaulted`，也不要在 handler 里写 `?? DEFAULT`。

## 写法

```ts
import { z } from "zod";

export const waitPrChecksParameters = z.object({
  number: z.union([z.number(), z.string()]).describe("PR number"),
  repo: z.string().optional().describe("OWNER/REPO"),
  fail_fast: z.boolean().default(true).describe("Exit immediately when any check fails"),
});

// handler 的参数类型从 schema 推断，不要另写 interface
type PrChecksWaitParams = z.infer<typeof waitPrChecksParameters>;

bus.registerCodemodeOnly({
  name: "wait-github-pr-checks",
  parameters: waitPrChecksParameters,
  structuredSchema: checksVerdictSchema,
  async execute(_id, params) {
    params.fail_fast; // boolean，默认值已应用
  },
});
```

要点：

- 带默认值的字段用 `.default(value)`；handler 里它是必填类型，不需要 `??`。
- `Type.Optional` 对应 `.optional()`；`Type.Union([X, Type.Null()])` 对应 `X.nullable()`（`null` 与 `undefined` 都允许时用 `.nullish()`）。
- `Type.Integer({ minimum, maximum })` 对应 `z.number().int().min(...).max(...)`。
- 参数对象默认用 `z.object`（未知键被剥掉）；**外部数据**（REST 响应等）的 `structuredSchema` 用 `z.looseObject` 保留额外字段，字段集由本仓库决定的载荷用 `z.strictObject`。
- 结构化结果用 `zodStructuredResult(schema, value)`（`src/lib/zod-tool.ts`）构造，`value` 按 schema 解析，类型自动对上。
- 需要宽松输入时写 `z.coerce.number()`：Zod 路径没有 TypeBox 的隐式 coerce，`"5"` 不会自动变成 `5`。

## 进上下文的写法

- **直接工具**：派生出的 JSON Schema 原样进模型，字段级 `description` / `default` / `enum` / `minimum` / `maximum` 都在。
- **codemode-only 工具**：模型看不到 JSON Schema，只看到 `renderDeclarations` 生成的 TS 声明。渲染器把字段的 `description`、`default`、数值与长度边界渲染成 JSDoc tag；`pattern` / `format` 不渲染，这类约束与互斥关系要写进 `description`。**不要**把边界重复写进 `description`（`max 50` 之类）。
- 渲染器支持 object / array / string / number / boolean / const / union / enum，以及 Zod 派生的数组形式 `type`（`["string","null"]`）；其它形状退化成 `unknown`。

## 输出 schema

`structuredSchema` 描述返回载荷：声明了它就必须返回 `structuredResult`，总线用 `Value.Parse` 复核派生出的输出 JSON Schema（`checkStructuredResult`），codemode 脚本拿到的 `Promise<T>` 也来自它。外部数据允许额外字段（`z.looseObject`），只描述工具真正依赖的字段。

## 非工具 schema：TypeBox

配置解析、协议、引擎响应等不经过工具总线的 schema 仍用 TypeBox（`Value.Parse` / `parseWithSchema`）。这些地方默认值仍走 `Default(schema, value)`（`src/lib/schema-defaults.ts`）——TypeBox 的 builder 会把 options 从类型里丢掉，`Default()` 把默认值留在类型上；`StaticDefaulted<T>` 是补过默认值之后的类型。不要写 `Type.Optional(Default(...))`。

## 常见错误

| 现象                              | 原因                                             | 修法                                        |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| 模型不知道默认值                  | 没写 `.default()`                                | 在 Zod 字段上 `.default(value)`             |
| 省略参数后类型仍是 `\| undefined` | 只写了 `z.boolean()`                             | 加 `.default(value)`                        |
| handler 里还要 `?? 常量`          | 默认值写在代码里而不是 schema                    | 把默认值移进 schema，删掉兜底               |
| 外部数据的额外字段丢了            | payload 用了 `z.object` / `z.strictObject`       | 外部数据用 `z.looseObject`                  |
| 边界在 codemode 里看不见          | 只写在 `description` 文本里                      | 写进 `minimum` / `maximum` / `minLength` 等 |
| 改了 schema 但 handler 类型没变   | 手写 interface 与 schema 各一份                  | `type X = z.infer<typeof schema>`           |
| codemode 里参数类型是 `unknown`   | schema 用了渲染器不支持的形状                    | 换成受支持的形状                            |
| 字符串参数被拒绝                  | Zod 路径不做隐式 coerce                          | 需要时用 `z.coerce.number()`                |
| `z.toJSONSchema` 注册时抛错       | 用了表达不了的构造（`z.custom` / `z.transform`） | 换成可表达的形状，或把变换放到 handler 里   |

> 本 skill 放在 `.agents/skills/`，只用于本仓库开发，不注册进 `package.json` 的 `pi.skills`。
