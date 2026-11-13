# Design

## Context

见 `proposal.md` 的 Why。当前执行器只靠 TUN 劫持（`dns-hijack: any:53`）接管 DNS，而 loopback 上的查询不出网络设备，永远进不了 TUN。

## Goals / Non-Goals

- 目标：受限模式下，宿主 `resolv.conf` 里配置的 nameserver（含 loopback 形式）都能被网络栈处理。
- 非目标：不改写沙箱内文件；不变更 DNS 白名单/拒绝语义（仍由过滤进程决定）；不影响 `block` / `allow-all`。

## Decisions

### 让过滤进程监听本机地址的 53，而不是改写沙箱内的 resolv.conf

候选一（未采用）：给 bwrap 加 `--ro-bind-data <fd> /etc/resolv.conf`，把沙箱内解析器改成 TUN 子网内地址。

- 宿主实测：`--file` 不可行（目标在只读树上，报 `Can't create file /etc/resolv.conf: Read-only file system`），`--ro-bind-data` 可行。
- 但它只覆盖被替换的那一份配置，还要牵进 fd 注入链路；沙箱内 `resolv.conf` 与宿主不一致，排查时容易误判。

候选二（采用）：过滤进程额外监听本机地址的 53（`0.0.0.0:53`）。

- 沙箱内的命令与过滤进程在同一个 network namespace，宿主的 `127.0.0.53` 在沙箱内就是本机地址，查询直达栈内解析器。
- 一并覆盖 `127.0.0.1`、dnsmasq / stub 这类其它本机地址写法；沙箱内文件保持原样。
- 宿主实测（`dns.listen: 127.0.0.53:5399`，其余字段与执行器生成的一致）：
  - 白名单域名 → `NOERROR`、应答 fake-ip（`198.18.0.4`）
  - 非白名单域名 → `NXDOMAIN`
    与 TUN 劫持路径一致，说明监听入口共用同一套 DNS 策略。
- 端口 53 在 netns 内是隔离的，不占用宿主端口；bind 需要 CAP_NET_BIND_SERVICE，init 在 userns 内是 root 因而具备（bind 失败会走现有启动失败路径）。

## Risks / Trade-offs

- IPv6 loopback（`::1`）形式的 nameserver 不在覆盖范围：沙箱内没有可用的 IPv6 出口（egress 通道只提供 IPv4），保持现状。
- 监听与 TUN 劫持并存：两者处理不同来源的查询、策略相同；集成用例覆盖 allowlist 放行与 DNS 层拒绝两条路径。
