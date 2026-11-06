# Spec Delta

## ADDED Requirements

### Requirement: 工具参数的 coercion 与枚举表达

总线对工具参数的接受与拒绝结论 MUST 与 pi 对同一次模型调用的结论一致：参数在校验前先按 schema coerce（数字串转数字、单值包成数组等），校验失败时的错误文本 MUST 指出出错字段的路径。只接受固定取值的参数 MUST 用 `enum` 表达取值集合，MUST NOT 用 `anyOf` / `const` 的组合（部分 provider 不支持）。

#### Scenario: 参数按 pi 的口径被 coerce

- **WHEN** 经总线调用一个参数 schema 要求字符串的工具，且传入的是数字
- **THEN** 工具收到该数字对应的字符串并正常执行，而不是收到参数校验失败

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
