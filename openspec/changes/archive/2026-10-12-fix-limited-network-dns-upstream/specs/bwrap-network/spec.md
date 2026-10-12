# Spec Delta

## MODIFIED Requirements

### Requirement: 受限网络模式下的沙箱内 DNS

`network: limited` 时，宿主 `/etc/resolv.conf` 里配置的 nameserver 查询 MUST 由网络栈处理：白名单域名 MUST 得到网络栈分配的地址，未允许域名 MUST 在 DNS 层被拒，解析结果 MUST 与连接层规则来自同一条目。

**MUST 覆盖 loopback 形式的解析器**：宿主使用 stub 解析器（如 systemd-resolved 的 `127.0.0.53`）时，发往这类本机地址的查询 MUST 同样由网络栈处理。

**MUST NOT 把 loopback 当作上游**：宿主 `resolv.conf` 里的 loopback 地址在沙箱内指向网络栈自身，MUST NOT 被用作解析上游——否则域名会被解析回网络栈分配的地址，出站连接因此超时。这类地址 MUST 被排除；全部被排除时 MUST 依次回退到宿主系统解析器维护的真实上游列表、egress 通道自带的解析器（它在宿主侧解析）。

该行为 MUST 只作用于受限网络模式：`block` 与 `allow-all` MUST NOT 改变沙箱内的解析行为。

#### Scenario: 宿主解析器是 loopback stub

- **WHEN** 宿主 `/etc/resolv.conf` 的 nameserver 是 loopback 地址（如 `127.0.0.53`），且宿主自身可解析外部域名
- **THEN** 沙箱内仍能解析 allowlist 域名，未允许域名仍在 DNS 层被拒

#### Scenario: 宿主只有 loopback 解析器时仍能建立连接

- **WHEN** 宿主 `/etc/resolv.conf` 只有 loopback 地址（如 `127.0.0.53`）
- **THEN** 沙箱内访问 allowlist 域名能真正连上（而不是解析成网络栈分配的地址后连接超时），未允许域名仍被拒

#### Scenario: 沙箱内的解析配置保持宿主原样

- **WHEN** 受限网络模式启动沙箱
- **THEN** 沙箱内 `/etc/resolv.conf` 与宿主一致，不被改写

#### Scenario: 非受限模式不改变解析行为

- **WHEN** 网络模式是 `block` 或 `allow-all`
- **THEN** 沙箱内的解析行为与宿主一致
