# Spec Delta

## ADDED Requirements

### Requirement: 声明渲染器支持数组形式 `type`

codemode 声明渲染器 MUST 把 JSON Schema 的数组形式 `type`（Zod 为 union / nullable 生成）渲染成联合类型，而不是退化成 `unknown`。

#### Scenario: nullable 字段

- **WHEN** 工具参数里的字段由 `z.string().nullable()` 派生为 `type: ["string","null"]`
- **THEN** codemode 声明里该字段的类型是 `string | null`

#### Scenario: union 字段

- **WHEN** 字段由 `z.union([z.number(), z.string()])` 派生为 `type: ["number","string"]`
- **THEN** codemode 声明里该字段的类型是 `number | string`
