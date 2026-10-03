# Spec Delta

## ADDED Requirements

### Requirement: 感知工具的结构化结果

四个感知工具（`aft_outline` / `aft_zoom` / `aft_callgraph` / `aft_search`）的成功结果 MUST 带 `structuredResult`，其载荷 MUST 是引擎响应自身的字段（去掉 envelope 的 request id）外加一个 `text`（与工具输出一致的渲染文本）。载荷 MUST 原样透传引擎字段：MUST NOT 丢弃脚本可能用得上的字段，MUST NOT 把引擎响应重新映射成另一套自定义形状。

声明的 schema MUST 宽松：引擎字段一律可选且允许额外字段，因为引擎是外部依赖，其响应会新增、改名或在预算耗尽时省略字段；把字段声明成必需会让引擎的版本变化把工具调用变成失败。宽松只针对字段的在场，MUST NOT 放宽类型校验：`text` MUST 是必需的字符串。

软失败（`symbol_not_found`、`callgraph_building`、`search_lanes_unavailable` 等引擎给出否定答案的码）MUST 保持「工具执行成功」的语义：载荷保留引擎的 `success: false` 与 `code`，脚本据 `code` 分支；MUST NOT 因此把它变成调用失败。工具的文本输出、`details` 与错误抛出行为 MUST 保持不变。

#### Scenario: outline 的文件条目

- **WHEN** `aft_outline` 以 files 模式分析目录
- **THEN** 载荷带引擎返回的 `files` 条目（`path` / `language` / `symbols` / `lines`）与截断标记，外加与工具输出一致的 `text`

#### Scenario: zoom 的符号与注解

- **WHEN** `aft_zoom` 查看一个符号
- **THEN** 载荷带 `name` / `kind` / `range` / `content` / `context_before` / `context_after` / `annotations`（`calls_out` / `called_by`）

#### Scenario: callgraph 按 op 取字段

- **WHEN** `aft_callgraph` 以任一 `op` 查询
- **THEN** 载荷带该 op 的引擎字段（`callers` / `children` / `paths` / `hops` / `total_*` / `truncated` 等）与 `text`，脚本按自己传入的 `op` 取用

#### Scenario: search 的命中列表

- **WHEN** `aft_search` 返回命中
- **THEN** 载荷带引擎的 `results` 条目（符号命中与降级时的 grep 行两种形状都在）、查询解释与截断/降级状态

#### Scenario: 引擎新增字段不导致失败

- **WHEN** 引擎响应里出现 schema 未声明的新字段
- **THEN** 载荷照样通过复核（新字段一并透传给脚本），调用不失败

#### Scenario: 软失败仍是成功调用

- **WHEN** 引擎以 `symbol_not_found` 或 `callgraph_building` 回应（`success: false`）
- **THEN** 工具照常返回文本，载荷保留 `success: false` 与 `code`，脚本据它决定是否重试

#### Scenario: 载荷不含 envelope 的 request id

- **WHEN** 任一感知工具成功返回
- **THEN** 载荷里没有传输层的 `id` 字段
