# Design

## Context

pi 的 `ToolDefinition.parameters` 必须是 JSON Schema；codemode 的声明渲染器（`src/codemode/declarations.ts`）读的也是 JSON Schema。TypeBox 的 schema 本身就是 JSON Schema 加类型标记，所以总线一直能直接把它交给 pi，并用 `Value.Convert → Value.Default → Parse` 解析参数。

Zod 不是 JSON Schema，但 `z.toJSONSchema(schema, { io })` 能产出等价形状：

- `io: "input"`：带 `.default()` 的字段不进 `required`，`default` 保留在字段上——模型看到「可省略，默认值是什么」。
- `io: "output"`：带默认值的字段进 `required`——返回值一定包含它们。

实测（Zod 4.6.7）派生结果覆盖渲染器已支持的全部关键字：`description`、`default`、`minimum`、`maximum`、`enum`、`const`、`anyOf`，以及数组形式 `type`（`z.union([z.number(), z.string()])` → `type: ["number","string"]`，`.nullable()` → `type: ["string","null"]`）。

关键约束：**派生出的 JSON Schema 不能交给 TypeBox 的 `Value` 做默认值或类型转换**。`Value.Default` / `Value.Convert` 按 TypeBox 的类型标记（`T.IsObject` 等）分派，普通 JSON Schema 没有这些标记，于是默认值不补、`"5"` 不转成 `5`。`Value.Parse` 与 `Value.Check` 则能正常校验普通 JSON Schema（实测拒绝越界值与错误类型）。

## Goals / Non-Goals

**Goals:**

- 工具 schema 只有一种写法（Zod），默认值是 Zod 的普通语义。
- 不改 pi 的契约：交给它的仍是 JSON Schema。
- TypeBox 声明的工具与配置 schema 继续工作，迁移可以逐文件推进。

**Non-Goals:**

- 不迁移非工具 schema（`tools-config.ts`、`lsp.json`、`proxy`、`bwrap`、`codemode/protocol`、`talk/mailbox` 等）。
- 不统一 coercion 语义：Zod 路径没有隐式 `Value.Convert`，需要宽松输入时用 `z.coerce`。
- 不删除 `schema-defaults.ts`（TypeBox 分支仍用 `StaticDefaulted`）。

## Decisions

### 解析交给 `prepareArguments`，总线不感知 Zod 的解析逻辑

pi 的 `ToolDefinition.prepareArguments` 是「schema 校验之前处理原始参数」的宿主钩子，总线在 `executeTool` / `executeCodemodeTool` 里也调用它。注册时把定义上的 `prepareArguments` 换成「先跑工具自己的（若有），再 `schema.parse`」：

- pi 路径：pi 调 `prepareArguments` → Zod 补默认值并校验 → pi 用自己的校验器校验派生 JSON Schema → `execute`。
- codemode 路径：总线调 `prepareArguments` → Zod 解析 → `Value.Convert → Value.Default → Parse` 作用在派生 JSON Schema 上（前两步是空操作，最后一步只做结构校验）→ `execute`。

这样总线不需要保存 Zod schema、不需要按名字查表、也不需要额外的钩子或类型；`normalize()` 只做两件事：派生 JSON Schema、包装 `prepareArguments`。纯 TypeBox 定义原样保存（`get()` 拿到的仍是注册时那个对象）。

被否掉的方案：

- **总线内保存 Zod schema 并按名字解析**：要在总线里维护第二套 schema 表与分支，`get()`/`list()` 的形状也会分叉。
- **只派生 JSON Schema、让 handler 自己 `schema.parse`**：总线的 `Value.Parse` 会先跑，`z.coerce` 收到的 `"5"` 在那一步就被拒，Zod 没有机会转换。
- **继续用 `Default()` / `StaticDefaulted`**：Zod 的 `.default()` 已经是类型层面的语义，`z.output` 直接给出「默认值已应用」的类型，仓库不需要再实现一遍。

### 类型用条件类型从 schema 推

```ts
export type ToolSchema = TSchema | ZodToolSchema;
export type ParamsValue<T extends ToolSchema> = T extends z.ZodType
  ? z.output<T>
  : StaticDefaulted<T>;
export type StructuredValue<T extends ToolSchema> = T extends z.ZodType ? z.output<T> : Static<T>;
```

`ToolDefinitionWithDefaults` 继承 `ToolDefinition<PiParams<TParams>, ...>`，`PiParams` 在 TypeBox 时原样保留参数类型（`renderCall` / `renderResult` 仍拿到具体形状），Zod 时退化成 `TSchema`（渲染器参数是 `unknown`）。这样 `defineStructuredTool` 的具体类型仍能赋给 `bus.register`，不需要双变 hack。

### 输出形态与复核

`structuredSchema` 用 `io: "output"` 派生，交给 codemode 渲染脚本侧返回类型；总线复核仍走 `Value.Parse`（派生 schema 已带 `required` / `type` / `enum` 等关键字）。工具构造结果时用 `zodStructuredResult(schema, value)`，让 `value` 在工具侧就按 Zod 解析并拿到 `z.output` 类型。

### `z.object` 与 `z.looseObject`

TypeBox 的 `Type.Object` 不限制额外属性，解析后原样保留；Zod 的 `z.object` 会剥掉未声明字段。因此 **外部数据**（GitHub REST 响应等）的 payload schema 用 `z.looseObject`，字段集由本仓库自己决定的载荷用 `z.strictObject`（对应原来的 `additionalProperties: false`）。

### 渲染器补数组形式 `type`

Zod 把 union / nullable 派生成 `type: [...]`，渲染器原来只认 `anyOf`，会让这些字段退化成 `unknown`。`renderType` 现在先展开数组形式 `type`，逐项递归后用 `|` 连接，得到 `string | null`、`number | string`。

## Risks / Trade-offs

- **coercion 语义变化**：Zod 路径不再把 `"5"` 静默转成 `5`，模型给错类型会直接报参数错误。需要宽松输入的工具显式用 `z.coerce`。缓解：这是更严格、更可预期的行为，skill 文档已写明。
- **`z.number().int()` 派生安全整数上下界**：`z.toJSONSchema` 会给整数补 `minimum/maximum: ±9007199254740991`，进模型上下文与 codemode 声明。无行为影响，只是声明更啰嗦。
- **两套 schema 方言并存**：工具已全是 Zod，非工具 schema 仍是 TypeBox。缓解：边界清晰（工具总线 vs 配置/协议），后续可单独迁移。
- **`z.toJSONSchema` 表达不了的构造**（`z.custom`、`z.transform`）在注册时直接抛错，不会静默降级。

## Migration Plan

1. 加 `zod` 依赖；`src/lib/zod-tool.ts` 提供派生函数与 `zodStructuredResult`。
2. 总线 `normalize()` + `ToolSchema` / `ParamsValue` / `StructuredValue`；`defineStructuredTool` 同步放宽。
3. 按文件并行迁移全部工具（aft、claude-code、opencode、gh、web、talk、codemode、lsp、bash-tool、session-name、spawn-agent、vision-agent）。
4. 渲染器补数组形式 `type`；修复迁移中暴露的类型派生（如 `ListQuery` 改用 `z.input`）。
5. 回滚：删除 `zod` 依赖与 `zod-tool.ts`，把工具 schema 换回 TypeBox 即可；总线对纯 TypeBox 定义的行为未变。
