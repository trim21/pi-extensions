# system-prompt Specification

## Purpose

本仓库完全接管 pi 的 system prompt 后的渲染契约：静态模板加占位符装配，把工具清单、工具指引、项目上下文与 skills 组装成每轮发送给模型的系统提示。

## Requirements

### Requirement: 工具级 guidelines 进入 system prompt

system prompt 渲染 MUST 收集本次会话可用工具的 `promptGuidelines`，并把它们与全局 guidelines 一起渲染进 guidelines 块。工具级指引的来源 MUST 是 pi 在 `before_agent_start` 事件中提供的按工具分组的指引集合；渲染 MUST NOT 依赖只承载全局条目的字段。渲染 MUST 只包含 `selectedTools` 中列出的工具的指引，MUST NOT 引入未激活或未注册工具的指引。条目 MUST 去除首尾空白、丢弃空串、按内容去重。没有任何条目时 MUST 省略整个 guidelines 块（含标题），保持与改动前一致。

#### Scenario: 工具声明的指引出现在 system prompt

- **WHEN** 某个已激活的工具声明了 `promptGuidelines`
- **THEN** 生成的 system prompt 的 guidelines 块包含这些指引的原文

#### Scenario: 未激活的工具不贡献指引

- **WHEN** 一个工具声明了 `promptGuidelines`，但它不在本次会话的 `selectedTools` 中（例如 `--tools` 限定或子代理白名单）
- **THEN** 生成的 system prompt 不包含该工具的指引

#### Scenario: 全局与工具级指引合并去重

- **WHEN** 全局 guidelines 与某个工具的 guidelines 含有同一条内容
- **THEN** 该内容在 guidelines 块中只出现一次

#### Scenario: 没有指引时省略块

- **WHEN** 本次会话没有任何工具声明 guidelines，也没有全局 guidelines
- **THEN** system prompt 中不出现 guidelines 标题，其余块的位置不受影响
