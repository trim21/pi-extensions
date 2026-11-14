# Spec Delta

## ADDED Requirements

### Requirement: 工具参数默认值

工具参数的默认值 MUST 由参数 schema 携带，且是唯一来源：省略该参数时工具 MUST 按 schema 的默认值执行，解析后的参数对该字段 MUST 有值（不是 `undefined`），工具实现 MUST NOT 再为它写一份兜底默认值。没有默认值的可选参数保持可选，解析后仍可能是 `undefined`。

#### Scenario: 省略带默认值的参数

- **WHEN** 调用方省略某个在参数 schema 上声明了默认值的参数
- **THEN** 工具按该默认值执行，而不是收到 `undefined` 或使用另一处硬编码的值

#### Scenario: 显式传值与默认值冲突

- **WHEN** 调用方显式传入该参数
- **THEN** 使用传入值，schema 的默认值不覆盖它

#### Scenario: 默认值在模型可见的声明里

- **WHEN** 工具声明渲染给模型（直接注册的 JSON Schema 或 codemode 的脚本声明）
- **THEN** 该参数的默认值可见，调用方不需要猜测省略后的取值

#### Scenario: 无默认值的可选参数

- **WHEN** 参数在 schema 上是可选的且没有声明默认值
- **THEN** 省略时工具收到 `undefined`，总线 MUST NOT 凭空补值
