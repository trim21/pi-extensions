# Spec Delta

## MODIFIED Requirements

### Requirement: 执行与返回

子 agent 以任务 prompt 启动，MUST 阻塞到本轮完成后再返回结果。

#### Scenario: 执行任务

- **WHEN** 调用 `spawn-agent`（`agent` + `task` 参数）
- **THEN** 创建隔离 session 执行任务，阻塞到本轮完成；结果返回最后一个 assistant 文本块

#### Scenario: 输出截断

- **WHEN** 结果超过 50KB
- **THEN** 截断并注明，全量消息保留在 details

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
