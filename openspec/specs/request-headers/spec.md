# request-headers Specification

## Purpose

为每次发往 provider 的请求附加当前会话 id，使网关侧可以按会话追踪与归属请求。

## Requirements

### Requirement: 请求携带会话 id

每次发往 provider 的请求 SHALL 在 `Thread-Id` 请求头中携带当前会话 id。

#### Scenario: 普通请求

- **WHEN** 当前会话发起一次 provider 请求
- **THEN** 请求头包含 `Thread-Id: <当前会话 id>`

#### Scenario: 会话切换后

- **WHEN** 用户 resume、fork 或新建会话后发起请求
- **THEN** `Thread-Id` 使用新会话的 id，而不是旧会话的 id

### Requirement: 覆盖同名请求头

请求上已存在 `Thread-Id` 时，扩展 SHALL 用当前会话 id 覆盖它。

#### Scenario: 已有同名请求头

- **WHEN** 上游请求链路已设置了 `Thread-Id`
- **THEN** 最终发出的请求使用当前会话 id，而不是原有值
