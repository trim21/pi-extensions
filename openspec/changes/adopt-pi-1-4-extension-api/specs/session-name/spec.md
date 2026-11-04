# Spec Delta

## MODIFIED Requirements

### Requirement: 自动命名

配置了命名模型时，把首条 user prompt 概括成短名。命名只由 user prompt 触发的 run 发起；由 custom message（`pi.sendMessage(..., { triggerTurn: true })`）触发的 run 没有 user prompt，不参与命名。

#### Scenario: 模型生成名字

- **WHEN** 配置了 `sessionName.model` 且会话有首条 user prompt
- **THEN** 调用命名模型把 prompt 概括成短名，输出截断到 `maxLength`

#### Scenario: 恢复无名会话补名

- **WHEN** resume / fork 恢复一个无名字的会话
- **THEN** 从历史第一条 user 消息生成名字

#### Scenario: custom message 触发的 run 不命名

- **WHEN** 一次 run 由 custom message 触发（事件类型为 `before_agent_start` 且 `messageType` 为 `custom`）
- **THEN** 不调用命名模型、不设置会话名，也不产生失败告警
