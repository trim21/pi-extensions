# Spec Delta

## MODIFIED Requirements

### Requirement: 配置分层合并

配置文件项目优先于全局，支持自定义可写路径、隐藏路径、网络 allowlist、审批规则与额外 bwrap 参数。

#### Scenario: 项目配置覆盖全局

- **WHEN** 项目 `.pi/sandbox.json` 与全局 `~/.pi/agent/sandbox.json` 都存在
- **THEN** 项目配置优先生效（可写路径覆盖、额外可写路径合并）

#### Scenario: 不存在的路径自动忽略

- **WHEN** 配置的可写或保护路径不存在
- **THEN** 对应 bwrap 挂载项被忽略，命令正常执行（`--*-bind-try` 语义）

#### Scenario: 模式可经命令切换

- **WHEN** 运行 `/bwrap-fs-readonly`、`/bwrap-fs-workspace-write`、`/bwrap-fs-allow-all`、`/bwrap-network-block`、`/bwrap-network-limited`、`/bwrap-network-allow-all`
- **THEN** 对应轴当前会话的取值即时切换（`/bwrap` 查看现状，`/bwrap-reload` 重读配置文件；网络栈由每条命令按当前配置现建现停，没有常驻实例需要重建）
