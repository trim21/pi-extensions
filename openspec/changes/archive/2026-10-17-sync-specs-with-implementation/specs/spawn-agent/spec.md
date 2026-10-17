# Spec Delta

## MODIFIED Requirements

### Requirement: 子 agent 清单

子 agent 从用户级 markdown 目录加载，增量式声明。

#### Scenario: 从 markdown 加载

- **WHEN** 读取 `~/.pi/agent/agents/*.md`
- **THEN** 解析 YAML frontmatter（`name` / `description` / `tools` / `provider` / `model` / `thinkingLevel` / `sandbox`）+ 正文作为 system prompt；校验失败的 md 被跳过

#### Scenario: 模型与工具解析

- **WHEN** 解析子 agent 的模型与工具
- **THEN** 模型按 frontmatter > `spawn-agent.json` 全局默认 > pi `settings.json` 默认的顺序解析；工具只由 frontmatter 的 `tools` 声明决定，未声明时使用默认只读工具集，不存在全局默认或 settings 的二级回退

### Requirement: 委托提示词

`spawn-agent` 向模型暴露的描述 MUST 给出委托判据、返回契约与并发语义，而不只是工具的能力说明，使模型能判断何时委托调研任务。

#### Scenario: 工具描述给出返回契约与并发语义

- **WHEN** 读取 `spawn-agent` 的工具描述与 `task` 参数描述
- **THEN** 描述说明子 agent 在隔离 session 中运行、看不到当前对话、只返回其最终回答（中间工具调用不可见）
- **AND** 描述说明同一条消息中的多个 `spawn-agent` 调用会并发执行

#### Scenario: task 参数要求自包含

- **WHEN** 读取 `task` 参数的描述
- **THEN** 描述要求任务自包含，写明仓库路径、确切问题与期望返回内容（文件路径 + 行号）

#### Scenario: guideline 给出委托判据

- **WHEN** 读取注入的 guideline
- **THEN** 其中列出该委托的情形（位置未知或多文件才能回答的只读调研、答案只需摘要、多个互相独立的调研点并发发起）与不该委托的情形（即将自己编辑的单文件、需要逐字原文作为证据、任何写操作）
- **AND** 说明子 agent 的结论只作为定位线索，动手改动前须自行核对其指出的位置
- **AND** 随后才列出可用子 agent 类型及其描述

#### Scenario: 工具出现在工具清单中

- **WHEN** 拼装 system prompt 的 "Available tools" 清单
- **THEN** `spawn-agent` 因带有 prompt snippet 而出现在该清单里

### Requirement: 执行与返回

子 agent 以任务 prompt 启动，MUST 阻塞到本轮完成后再返回结果。

#### Scenario: 执行任务

- **WHEN** 调用 `spawn-agent`（`agent` + `task` 参数）
- **THEN** 创建隔离 session 执行任务，阻塞到本轮完成；结果返回最后一个 assistant 文本块

#### Scenario: 输出截断

- **WHEN** 结果超过 50KB
- **THEN** 截断并注明；details 只保留折叠面板，不保留全量消息

#### Scenario: 进度可见

- **WHEN** 子 agent 运行中
- **THEN** 通过 `onUpdate` 滚动展示进度：工具/文本日志行只保留最近 4 行，末尾固定一行「子 agent 名 + 实时 usage」；面板最多 6 行内容（4 行日志 + 1 行瞬态 thinking + 1 行固定 metadata）
- **AND** 同一 run 内连续的（含跨 thinking 与跨轮次）工具调用合并进同一行：工具名按调用顺序罗列，同名连续出现折叠为 `name x N`；thinking 不打断合并，只有文本块另起一行
- **AND** thinking 期间在日志与末尾固定行之间插一行瞬态 `thinking ( N chars )` 显示实时字符数，thinking 结束即消失、不占日志行
- **AND** 过长的日志行内容折叠为「前 9 字符 + 空格 + `…` + 空格 + 后 9 字符」，被省去的中段不再显示
- **AND** 末尾固定行显示的模型名是本次运行实际生效的模型（frontmatter 的模型解析不到时即 SDK fallback 后的模型），而不是 frontmatter 里声明的名字

#### Scenario: 进度推送限流

- **WHEN** 子 agent 在一个短窗口内连续产生多个进度事件（例如逐 chunk 的 thinking 增量）
- **THEN** `onUpdate` 的推送被限流，相邻两次推送之间的最小间隔为 100ms，与 bash 工具的进度限流间隔一致
- **AND** 被限流吞掉的中间事件不丢失最终状态：窗口结束时的最后一次事件仍会以最新状态推送一次，面板内容与不限流时一致
