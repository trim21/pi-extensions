# Spec Delta

## ADDED Requirements

### Requirement: Zod 参数 schema 的注册路径

工具 MAY 用 Zod 声明 `parameters` 与 `structuredSchema`。总线 MUST 在注册时把 Zod schema 派生为 JSON Schema 交给 pi 与 codemode 声明渲染器（参数用输入形态，结构化输出用输出形态），MUST NOT 把 Zod 对象本身交给 pi。参数解析 MUST 由 Zod 完成：默认值、取值边界与错误信息以 Zod schema 为唯一来源，handler 的参数类型 MUST 是解析后的类型。未使用 Zod 的工具 MUST 保持原有 TypeBox 解析行为。

#### Scenario: 参数 JSON Schema 由 Zod 派生

- **WHEN** 一个工具用 Zod 声明参数，字段上带 `.default()` 与 `.min()` / `.max()`
- **THEN** 交给 pi 的 `parameters` 是派生出的 JSON Schema，包含 `description`、`default` 与边界关键字，且不含 Zod 对象本身
- **AND** codemode 声明里该字段渲染出 `@default` 与边界 tag

#### Scenario: 省略带默认值的参数

- **WHEN** 调用方省略一个在 Zod schema 上带 `.default()` 的参数
- **THEN** 工具按该默认值执行，handler 收到的该字段有值

#### Scenario: 参数越界被拒绝

- **WHEN** 调用方传入的值超出 Zod schema 声明的边界
- **THEN** 调用以参数错误结束，错误信息包含该字段的路径，工具不被执行

#### Scenario: 结构化输出按派生 schema 复核

- **WHEN** 工具返回的 `structuredResult.value` 与它声明的输出 schema 不符
- **THEN** 总线报错，而不是把值 coerce 成能通过校验的形状

#### Scenario: 未迁移的工具行为不变

- **WHEN** 某个工具仍用 TypeBox 声明参数
- **THEN** 它的注册、参数解析（含 `Value.Convert` 的隐式类型转换）与结构化结果复核与本次改动前一致

## MODIFIED Requirements

### Requirement: 工具参数的 coercion 与枚举表达

总线对工具参数的接受与拒绝结论 MUST 与 pi 对同一次模型调用的结论一致。参数的类型转换 MUST 由参数 schema 自己承担：Zod 声明的工具 MUST NOT 由总线做隐式类型转换（`"5"` 不会变成 `5`，单值不会被包成数组），需要宽松输入的工具 MUST 在 schema 上用 `z.coerce` / `booleanParam()` 之类显式声明；未迁移的 TypeBox 工具 MUST 保持原有的 `Value.Convert` 隐式转换。校验失败时的错误文本 MUST 指出出错字段的路径。只接受固定取值的参数 MUST 用 `enum` 表达取值集合，MUST NOT 用 `anyOf` / `const` 的组合（部分 provider 不支持）。

#### Scenario: 参数按 schema 声明的口径被 coerce

- **WHEN** 工具在参数 schema 上用 `z.coerce.number()` 声明一个数字参数，调用方传入 `"42"`
- **THEN** 工具收到数字 `42` 并正常执行，结论与 pi 直接调用该工具时一致

#### Scenario: 未声明转换的 Zod 参数不静默改值

- **WHEN** 参数在 Zod schema 上是 `z.string()`，调用方传入数字
- **THEN** 调用以参数错误结束，工具不被执行，参数不会被静默转成字符串

#### Scenario: TypeBox 工具仍走隐式转换

- **WHEN** 一个未迁移的工具用 TypeBox 声明 `integer` 参数，调用方传入 `"4"`
- **THEN** 工具收到数字 `4`，与本次改动前一致

#### Scenario: 校验失败错误带字段路径

- **WHEN** 参数缺少 schema 要求的必填字段
- **THEN** 错误文本包含该字段的路径，调用方不需要自己推断是哪个参数不对

#### Scenario: 固定取值集合以 enum 表达

- **WHEN** 某个工具参数只接受一组固定取值
- **THEN** 该参数的 schema 用 `enum` 列出全部取值
- **AND** codemode 生成的工具声明把它渲染成取值联合

#### Scenario: 未声明的多余参数照旧被容忍

- **WHEN** 模型给某个工具传了它的参数 schema 未声明的字段
- **THEN** 结论与本次改动前一致：此前允许多余参数的工具照常执行并忽略这些字段

#### Scenario: 结构化结果的复核不做 coercion

- **WHEN** 工具返回的 `structuredResult.value` 与它声明的 `structuredSchema` 不符
- **THEN** 总线报错，而不是先把值 coerce 成能通过校验的形状
