# Proposal

## Why

上一个 change（`fix-limited-network-loopback-dns`，已合并）让过滤进程监听本机地址的 53，使宿主 `resolv.conf` 里的 loopback stub 查询能被网络栈接住。但那只是修复的一半：网络栈自己的**上游**仍然来自宿主 `resolv.conf`（stub 环境即 `127.0.0.53`），而该地址在 netns 内指向的正是这个新监听。

结果是 DIRECT 出站把域名解析回网络栈分配的 fake IP。宿主实测的 mihomo 日志：

```
[TCP] dial DIRECT (match Domain/pypi.org) ... error: dial tcp 198.18.0.4:443: i/o timeout
curl: (35) TLS connect error: error:0A000126:SSL routines::unexpected eof while reading
```

即 stub 环境下 `network: limited` 从「解析失败」变成「连接超时」，仍然不可用。

## What Changes

- 上游 DNS 候选值排除 loopback 地址（在沙箱内它们指向网络栈自身）与 IPv6（egress 通道只提供 IPv4）。
- 宿主 `resolv.conf` 全被排除（stub 环境）时依次回退：宿主系统解析器维护的真实上游列表（systemd-resolved 的 `/run/systemd/resolve/resolv.conf`）→ egress 通道自带的解析器（它在宿主侧解析）。
- 沙箱内的解析配置仍然保持宿主原样。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap-network`：「受限网络模式下的沙箱内 DNS」增加上游约束——loopback MUST NOT 作为解析上游，被排除后 MUST 按上述顺序回退。

## Impact

- 代码：`src/bwrap/network-stack.ts`（`resolveDnsServers` 拆出可测的 `routableDnsServers` 并加回退链）与新增 `test/bwrap-network-stack.test.ts`。
- 行为：systemd-resolved stub 环境下 `network: limited` 从「连接超时」变为可用。
