# Tasks

## 1. 栈内解析器监听本机地址

- [x] 1.1 `native/mihomo.go`：DNS 配置增加监听本机地址的 53（`0.0.0.0:53`），并注释用途——宿主 `resolv.conf` 指向 loopback stub 时，查询由此到达栈内解析器。
- [x] 1.2 `native/mihomo_test.go`：断言生成的配置含该监听字段，既有 DNS 字段不受影响。
- [x] 1.3 `native/README.md`：在网络路径说明里补一句（DNS 有 TUN 劫持与本机 53 监听两条入口）。

## 2. 验证与归档

- [x] 2.1 `native/`：`go test ./...`、`go vet ./...`、`gofmt -l` 干净。
- [x] 2.2 宿主端到端：`RUN_NETSTACK_INTEGRATION=1` 全部通过（含 allowlist 放行/拒绝、超时无残留）。
- [x] 2.3 宿主上验证 loopback 入口：用执行器在沙箱内查询本机地址的 53（`dig @127.0.0.1 -p 53 pypi.org`），确认应答来自栈内解析器（fake-ip 地址段）。
- [x] 2.4 `test/bwrap-netstack-integration.test.ts`：增加断言——沙箱内 `/etc/resolv.conf` 与宿主内容一致（未被改写）。
- [x] 2.5 `pnpm run check`、`pnpm run lint`、`pnpm test` 全绿。
- [x] 2.6 CI：push 后 runner（systemd-resolved stub 环境）上 `test/bwrap-netstack-integration.test.ts` 不再有失败用例。
- [x] 2.7 归档：delta 合并进 `openspec/specs/bwrap-network/spec.md`（Implementation 段补充该机制），change 移入 `archive/`。
