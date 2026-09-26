# Spec Delta

## MODIFIED Requirements

### Requirement: allowlist 网络访问控制

沙箱内命令只能访问配置允许的网络目标（域名 / IP / CIDR，可带端口），其余一律拒绝。

**双重拒绝**：未允许的域名在 **DNS 层**即被拒绝——DNS 查询直接失败（表现为 `Could not resolve host`），进程拿不到可连接的地址，效果等同于"该进程没有网络"；即使绕过 DNS（直连 IP），未允许的 IP/端口也会在连接层被拒绝。

**拒绝语义**：未允许域名的解析 MUST 立即失败（不依赖上游超时，也不返回 fakeip 等占位地址）；allowlist 域名的解析 MUST 走配置的 DNS 服务器。连接层 MUST 保留兜底拒绝，覆盖裸 IP 连接与自行解析（如 DoH、内置解析器）的客户端。

#### Scenario: allowlist 域名可直连

- **WHEN** 沙箱内命令访问 allowlist 中的域名
- **THEN** 该域名正常解析且连接成功

#### Scenario: 未允许域名解析失败

- **WHEN** 沙箱内命令解析不在 allowlist 中的域名
- **THEN** 解析直接失败，不返回可连接的地址（而非连接阶段才报错）

#### Scenario: 未允许域名解析立即失败

- **WHEN** 沙箱内命令解析不在 allowlist 中的域名
- **THEN** 解析在毫秒级失败，不等待上游 DNS 超时；失败原因是解析被拒（NXDOMAIN / 拒绝），不是不可达

#### Scenario: 未允许目标在连接层被拒绝

- **WHEN** 沙箱内命令连接不在 allowlist 中的 IP 或端口
- **THEN** 连接被拒绝

#### Scenario: 带端口的条目精确放行

- **WHEN** allowlist 条目携带端口（如 `example.com:443`）
- **THEN** 仅该域名与端口的组合放行，其余端口拒绝

#### Scenario: IPv6 条目要求方括号

- **WHEN** allowlist 条目包含裸 IPv6 地址（未用 `[]` 包裹）
- **THEN** 配置校验失败并提示用方括号包裹
