# Proposal

## Why

`network: limited` 模式下每条 Bash 命令要多花约 **2.09s**，其中 2.01s 是停栈时白等的固定超时——起栈只用 41ms、命令本身 37ms。原因是 `stop()` 用 SIGTERM 终止 holder 进程（`unshare -Urnp --fork --kill-child=SIGTERM`），而 util-linux 的 `unshare` 在 fork 前会永久阻塞 SIGINT/SIGTERM、且只在子进程里恢复掩码：SIGTERM 只会 pending 永不投递，`waitForExit(holderPid)` 于是走满默认的 2000ms，真正生效的是它后面那条 SIGKILL 兜底。启动失败路径（catch 里的清理）同样白等 2s。

## What Changes

- 停栈与启动失败清理改用 SIGKILL 终止 holder（unshare 包装进程）：`--kill-child=SIGTERM` 的语义是 unshare 死亡时给 pid ns init（node holder）设 `PR_SET_PDEATHSIG`，init 收到 SIGTERM 后优雅停 mihomo 再退出，内核随后清理 pid ns。实测全树约 100ms 内退干净，无残留进程或 namespace。
- `stackFinalizer` 的 GC 兜底 kill 同步修正——那里的 SIGTERM 同样是空操作。
- 每条命令的沙盒开销回到 **~0.18s**（起栈 41ms + 执行 37ms + 停栈 ~100ms），与历史记录的「约 140ms」同一量级。
- 修正 `--kill-child` 的错误描述：`openspec/specs/bwrap-network/spec.md` 与 `src/bwrap/network-stack.ts` 注释里写的「宿主侧 SIGTERM unshare 时转发给 init」与 util-linux 实际行为不符（`src/bwrap/README.md` 的进程树注释本来就是对的）。
- 更新 `src/bwrap/README.md` 与 `src/bwrap/sandbox.ts` 的过期说明：README 的「一个 session 内 N 条命令复用同一套常驻栈」已不成立（现在每条命令现建现停，这正是当年按 ~140ms 开销改掉常驻栈时的行为），`sandbox.ts` 注释里的「启动约 140ms」也不是实测值。
- 集成测试补一条停栈耗时回归断言。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap-network`: 「网络栈生命周期管理」补充停栈即时完成的场景——明确停止网络栈不得依赖 holder 会响应的信号，且不得出现固定 2s 级等待。

## Impact

- 代码：`src/bwrap/network-stack.ts`（`stop()`、启动失败清理、`stackFinalizer`、相关注释）、`src/bwrap/sandbox.ts`（注释）、`src/bwrap/README.md`。
- 规范：`openspec/specs/bwrap-network/spec.md`（Requirement 场景 + Implementation 里 `--kill-child` 的描述）。
- 测试：`test/bwrap-netstack-integration.test.ts`（`RUN_NETSTACK_INTEGRATION=1` 下手动运行，需真实 mihomo / slirp4netns / unshare）。
- 不涉及配置格式、公共 API 或依赖变更；`network: block` / `allow-all` 路径不受影响。
