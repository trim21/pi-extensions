# Proposal

## Why

`network: limited` 下沙箱内命令的 DNS 解析读的是宿主那份 `/etc/resolv.conf`。当宿主用 systemd-resolved 的默认配置（`nameserver 127.0.0.53`，Ubuntu / Debian 的常见默认）时，这个地址是 loopback：loopback 流量不出网络设备、进不了 TUN，过滤进程的 `dns-hijack: any:53` 拦不到它，而沙箱内的 loopback 上没有任何解析器，于是**所有**域名解析立即失败——allowlist 里的域名也用不了。

这个问题此前一直没被发现，是因为 CI 上的真实网络栈用例长期整组跳过（门控变量从未设置、受限 userns 下探测失败）。把用例在 CI 上打开后第一次运行就抓到了：runner 的 `/etc/resolv.conf` 是 `nameserver 127.0.0.53`，沙箱内 `getent ahostsv4 pypi.org` 输出为空。开发机之所以一直绿，只是因为它的 `resolv.conf` 写的是真实 DNS 地址。

## What Changes

- 受限网络模式（`network: limited`）下，过滤进程除 TUN 劫持外**再监听本机地址的 53 端口**。宿主的 `resolv.conf` 指向 loopback stub 时，查询直达栈内解析器，仍按 allowlist 规则处理（白名单域名拿到网络栈分配的地址、其余在 DNS 层被拒）。
- 沙箱内的文件系统与宿主 `resolv.conf` 保持原样：不改写、不注入。
- 非受限模式不变：`block` 无网络，`allow-all` 不该改变用户的解析行为。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap-network`：新增「受限网络模式下的沙箱内 DNS」要求——宿主 `resolv.conf` 里配置的 nameserver 查询 MUST 由网络栈处理，**MUST 覆盖 loopback 形式的解析器地址**；`block` / `allow-all` MUST NOT 改变沙箱内的解析行为。

## Impact

- 代码：`native/mihomo.go`（DNS 配置增加监听）与 `native/mihomo_test.go`；`test/bwrap-netstack-integration.test.ts` 增加一条断言（沙箱内 `resolv.conf` 未被改写）。
- 行为：宿主使用 stub 解析器时 `network: limited` 从「DNS 完全不可用」变为可用；宿主 `resolv.conf` 的内容不再影响沙箱内解析（DNS 策略由网络栈决定）。
- CI：runner 就是 stub 环境，这条修复后集成用例转为通过。
