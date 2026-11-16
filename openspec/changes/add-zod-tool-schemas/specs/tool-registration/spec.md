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
