# Tasks

## 1. 停栈信号修正（代码与注释）

- [x] 1.1 `src/bwrap/network-stack.ts` 的 `stop()` 与启动失败 catch 块改用 SIGKILL 终止 holder（`killProcess(state.holderPid, "SIGKILL")`），slirp 保持 SIGTERM、`readChildPids` + SIGKILL 兜底保留；验证：unsandboxed 跑 `PATH=~/.nix-profile/bin:$PATH pnpm sandbox --fs=workspace-write --network=limited -- 'echo 1'`，`# exit=0 in <ms>` 的耗时从 ~2090ms 降到 500ms 以内
- [x] 1.2 `stackFinalizer` 的 GC 兜底 kill 同步改为 SIGKILL；验证：`grep -n "killProcess" src/bwrap/network-stack.ts` 逐处确认 holder 的终止信号都是 SIGKILL、slirp 的是 SIGTERM
- [x] 1.3 改写相关注释：`network-stack.ts` 里「SIGTERM unshare → --kill-child 转发给 init」的说法改为「SIGKILL unshare → 子进程 PDEATHSIG 收到 SIGTERM」；`sandbox.ts` 的「启动约 140ms」改为实测量级（起栈 ~40ms / 执行 ~40ms / 停栈 ~100ms）；验证：`grep -rn "转发\|140ms" src/bwrap/*.ts` 无残留的错误描述

## 2. 停栈耗时回归测试

- [x] 2.1 `test/bwrap-netstack-integration.test.ts` 增加停栈耗时断言（`stop()` 在 1s 内返回、且退出后 holder pid 不再存在）；验证：先只回退 1.1 的信号改动确认该断言失败，再恢复后 `RUN_NETSTACK_INTEGRATION=1 NETSTACK_DNS=223.5.5.5 pnpm exec vitest run test/bwrap-netstack-integration.test.ts` 通过（需 unsandboxed 执行）

## 3. 规范与文档同步

- [x] 3.1 `openspec/specs/bwrap-network/spec.md` 的 Implementation 段按实际行为改写：`--kill-child=SIGTERM` 的语义（子进程 PDEATHSIG，非信号转发）、进程树里 slirp4netns 的位置（由 pi 在宿主 netns 启动、经 exit-fd 绑定生命周期，不在 pid ns 内、不被内核连带清理）、holder.js 的实际参数；验证：逐条与 `src/bwrap/network-stack.ts`、`src/bwrap/holder.ts` 的实现对照，无与代码不符的表述
- [x] 3.2 `src/bwrap/README.md` 的「一个 session 内 N 条命令复用同一套常驻栈」改为每条命令现建现停（保留「allowlist 变更即时生效」的理由），生命周期表里「正常 stop()」一行改为 SIGKILL holder + PDEATHSIG 的实现；验证：README 与 `sandbox.ts` 的实际调用路径一致，不再出现常驻栈的说法
- [x] 3.3 跑 `openspec validate fix-bwrap-netstack-stop-latency --strict` 通过

## 4. 集成验证

- [x] 4.1 `pnpm check`、`pnpm lint`、`pnpm test` 全绿（prettier 在改动完成后再统一跑一次）
- [x] 4.2 unsandboxed 连续跑 3 次 `pnpm sandbox --fs=workspace-write --network=limited -- 'echo 1'`，确认每条都在 500ms 内结束，且 `ps` 中无残留 `unshare` / `mihomo` / `slirp4netns`（实测 127 / 229 / 130ms，无残留进程）。原任务还断言 `~/.pi/agent/tmp/` 无残留 mihomo 目录——实测有 10026 个共 196MB：`startNetworkStack` 只 `mkdir` 从不删除，与停栈信号无关，已拆到单独的 change 处理
