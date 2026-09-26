# Tasks

## 1. 临时目录清理路径

- [x] 1.1 `src/bwrap/network-stack.ts` 的 `stop()` 末尾删除本次实例的 `mihomoHome`（`rm(dir, { recursive: true, force: true })`，失败静默吞掉）；验证：unsandboxed 跑 `PATH=~/.nix-profile/bin:$PATH pnpm sandbox --fs=workspace-write --network=limited -- 'echo 1'` 后，`~/.pi/agent/tmp/` 下不新增 `mihomo-*` 目录
- [x] 1.2 `stackFinalizer` 同样删除：`NetworkStackState` 带上 `mihomoHome`、finalizer 用 fire-and-forget 的 `void rm(...).catch(...)`；启动失败路径**不删**（保留现场，见 spec 与 design D4）；验证：`grep -n "rm(state.mihomoHome" src/bwrap/network-stack.ts` 两处（stop + finalizer），`catch` 里只有说明为何不删的注释
- [x] 1.3 补注释说明删除是 best-effort、失败不影响命令结果，以及失败路径为何保留；验证：注释与 `runInSandbox` 的 `finally` 处理语义一致（停栈失败不掩盖命令结果）

## 2. 回归测试

- [x] 2.1 `test/bwrap-netstack-integration.test.ts` 增加断言：起栈后临时目录存在、`stop()` 后不存在；验证：先注释掉 1.1 的删除确认该断言失败，再恢复后 `RUN_NETSTACK_INTEGRATION=1 NETSTACK_DNS=223.5.5.5 pnpm exec vitest run test/bwrap-netstack-integration.test.ts -t "mihomo work dir"` 通过（需 unsandboxed 执行）

## 3. 集成验证

- [x] 3.1 `pnpm check`、`pnpm lint`、`pnpm test` 全绿
- [x] 3.2 unsandboxed 连跑 3 次 `pnpm sandbox --fs=workspace-write --network=limited -- 'echo 1'`，确认耗时仍在 ~200ms 量级、无残留进程、`~/.pi/agent/tmp/` 下无新增 `mihomo-*` 目录
