# Spec Delta

## MODIFIED Requirements

### Requirement: 请求携带会话 id

每次发往 provider 的请求 SHALL 在 `Thread-Id` 请求头中携带发出该请求的会话 id，包括主会话与 spawn-agent 等内联创建的会话。

#### Scenario: 普通请求

- **WHEN** 当前会话发起一次 provider 请求
- **THEN** 请求头包含 `Thread-Id: <当前会话 id>`

#### Scenario: 会话切换后

- **WHEN** 用户 resume、fork 或新建会话后发起请求
- **THEN** `Thread-Id` 使用新会话的 id，而不是旧会话的 id

#### Scenario: 子代理请求

- **WHEN** spawn-agent 创建的子代理会话发起 provider 请求
- **THEN** 请求头包含 `Thread-Id: <该子代理会话自己的 id>`，而不是父会话的 id
