# Tasks

## 1. 过滤进程监听本机地址的 53

- [x] 1.1 `src/bwrap/mihomo-config.ts`：DNS 配置类型与生成处增加 `listen`（`0.0.0.0:53`），并注释用途——宿主 `resolv.conf` 指向 loopback stub 时，查询由此到达网络栈内的解析器。
- [x] 1.2 `test/bwrap-mihomo-config.test.ts`：断言生成的配置含该监听字段，既有 DNS 字段不受影响。
- [x] 1.3 `test/bwrap-netstack-integration.test.ts`：增加断言——沙箱内 `/etc/resolv.conf` 与宿主内容一致（未被改写）。

## 2. 验证与归档

- [x] 2.1 宿主端到端：`RUN_NETSTACK_INTEGRATION=1` 全部通过（含 allowlist 放行/拒绝、超时无残留）。
- [x] 2.2 宿主上验证 loopback 入口：在沙箱内查询本机地址的 53，确认应答来自网络栈内的解析器（fake-ip 地址段）。
- [x] 2.3 `pnpm run check`、`pnpm run lint`、`pnpm test` 全绿。
- [ ] 2.4 归档：delta 合并进 `openspec/specs/bwrap-network/spec.md`，change 移入 `archive/`。
