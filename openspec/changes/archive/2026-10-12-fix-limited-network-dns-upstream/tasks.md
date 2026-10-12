# Tasks

## 1. 上游 DNS

- [x] 1.1 `src/bwrap/network-stack.ts`：拆出 `routableDnsServers`（排除 loopback 与 IPv6），`resolveDnsServers` 按「宿主 `resolv.conf` → systemd-resolved 真实上游 → egress 解析器」回退。
- [x] 1.2 新增 `test/bwrap-network-stack.test.ts`：覆盖排除 loopback、排除 IPv6、保留顺序与空结果。
- [x] 1.3 主 spec 的 Implementation 段补充该机制，并归档两个 change（`fix-limited-network-loopback-dns` 与本次）。

## 2. 验证

- [x] 2.1 宿主端到端：`RUN_NETSTACK_INTEGRATION=1` 全部通过。
- [x] 2.2 宿主上用执行器验证上游可达：policy 的 `dnsServers` 取 egress 解析器时，allowlist 域名能连上（`http=200`）。
- [x] 2.3 `pnpm run check`、`pnpm run lint`、`pnpm test` 全绿。
- [ ] 2.4 CI：push 后 runner（systemd-resolved stub 环境）上集成用例通过。
