# Spec Delta

## MODIFIED Requirements

### Requirement: 消息安全限制

纯文本消息有大小与速率限制，防止消息环与滥用。

#### Scenario: 超限消息被拒

- **WHEN** 消息超过 32KB、10 秒内重复、30 秒内超过 8 条，或目标未读积压已达到 50 条
- **THEN** 消息被拒绝（防环与限速）；积压为 50 条时尝试发送的第 51 条即被拒

#### Scenario: 来源标注

- **WHEN** 消息来自另一个 pi session
- **THEN** 投递时标注来源（非用户消息）
