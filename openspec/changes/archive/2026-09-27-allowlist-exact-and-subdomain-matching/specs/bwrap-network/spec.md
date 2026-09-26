# Spec Delta

## MODIFIED Requirements

### Requirement: allowlist 网络访问控制

沙箱内命令只能访问配置允许的网络目标（域名 / IP / CIDR，可带端口），其余一律拒绝。

**条目匹配语义**：域名条目分两档——裸域名（`example.com`）MUST 精确匹配该域名本身，不匹配其子域名；`*.` 前缀（`*.example.com`）MUST 匹配该域名的全部子域名（任意深度），MUST NOT 匹配 apex 本身。需要同时放行 apex 与子域名时 MUST 单列两条。端口后缀（`example.com:443`、`*.example.com:443`）MUST 只约束连接层端口，不改变域名匹配语义。含通配的条目 MUST 通过语法校验：`*` 必须占据最左且完整的标签，`*` 单独出现、出现在中间标签、与非空标签拼接（`*example.com`）或用于 IP 条目时 MUST 报配置错误。

**双重拒绝**：未允许的域名在 **DNS 层**即被拒绝——DNS 查询直接失败（表现为 `Could not resolve host`），进程拿不到可连接的地址，效果等同于"该进程没有网络"；即使绕过 DNS（直连 IP），未允许的 IP/端口也会在连接层被拒绝。

**拒绝语义**：未允许域名的解析 MUST 立即失败（不依赖上游超时，也不返回 fakeip 等占位地址）；allowlist 域名的解析 MUST 走配置的 DNS 服务器。连接层 MUST 保留兜底拒绝，覆盖裸 IP 连接与自行解析（如 DoH、内置解析器）的客户端。DNS 白名单与连接层规则 MUST 由同一条目生成等价的目标集合。

#### Scenario: allowlist 域名可直连

- **WHEN** 沙箱内命令访问 allowlist 中的域名
- **THEN** 该域名正常解析且连接成功

#### Scenario: 裸域名精确匹配

- **WHEN** allowlist 含 `example.com`，沙箱内命令访问 `example.com`
- **THEN** 放行；访问 `www.example.com` 或 `a.b.example.com` 时被拒（解析失败，不返回可连接地址）

#### Scenario: 通配条目匹配子域名

- **WHEN** allowlist 含 `*.example.com`，沙箱内命令访问 `www.example.com` 或 `a.b.example.com`
- **THEN** 正常解析且连接成功；访问 `example.com` 本身时被拒

#### Scenario: 通配条目不误伤同后缀域名

- **WHEN** allowlist 含 `*.example.com`，沙箱内命令访问 `notexample.com`
- **THEN** 被拒（匹配按标签边界，不按字符串后缀）

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

- **WHEN** allowlist 条目携带端口（如 `example.com:443` 或 `*.example.com:443`）
- **THEN** 仅该域名集合与端口的组合放行，其余端口拒绝

#### Scenario: 通配语法非法时报错

- **WHEN** allowlist 出现 `*`、`*example.com`、`a.*.example.com`、`*.1.2.3.4` 这类条目
- **THEN** 配置校验失败并提示合法写法（`*.` 必须是完整的、位于最左的标签，且只用于域名）

#### Scenario: IPv6 条目要求方括号

- **WHEN** allowlist 条目包含裸 IPv6 地址（未用 `[]` 包裹）
- **THEN** 配置校验失败并提示用方括号包裹
