# Design

## Context

见 `proposal.md` 的 Why。当前实现只靠 TUN 劫持（`dns-hijack: any:53`）接管 DNS，而 loopback 上的查询不出网络设备，永远进不了 TUN；命令经 `nsenter` 进入网络栈的 netns 执行，所以宿主的 `127.0.0.53` 在沙箱内就是本机地址。

## Goals / Non-Goals

- 目标：受限模式下宿主 `resolv.conf` 里的 nameserver（含 loopback 形式）都能被网络栈处理。
- 非目标：不改写沙箱内文件；不变更 DNS 白名单/拒绝语义；不影响 `block` / `allow-all`。

## Decisions

### 让过滤进程监听本机地址的 53

另一条路是把沙箱内的 `/etc/resolv.conf` 换成栈内解析器地址：argv 由本层组装，得在 bwrap 参数里用 `--ro-bind-data` 并牵进 fd 传递链路，而且只覆盖被替换的那一份文件。

监听本机地址的 53 更简单，也顺带覆盖 `127.0.0.1`、dnsmasq / stub 这类其它本机地址写法；沙箱内文件保持原样。

宿主实测（`dns.listen: 127.0.0.53:5399`，其余字段与本实现生成的一致）：

- 白名单域名 → `NOERROR`、应答 fake-ip（`198.18.0.4`）
- 非白名单域名 → `NXDOMAIN`

说明监听入口与 TUN 劫持共用同一套 DNS 策略。端口 53 在 netns 内是隔离的，不占用宿主端口。

## Risks / Trade-offs

- IPv6 loopback（`::1`）形式的 nameserver 不在覆盖范围：egress 通道只提供 IPv4，保持现状。
- 监听与 TUN 劫持并存：两者处理不同来源的查询、策略相同；集成用例覆盖 allowlist 放行与 DNS 层拒绝两条路径。
