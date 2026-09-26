# Design

## Context

动机见 `proposal.md` - Why。这里只列影响方案的现状与约束。

- `stop()`（`src/bwrap/network-stack.ts`）当前依次：`readChildPids(holderPid)` → SIGTERM slirp → SIGTERM holder → `waitForExit(holderPid)` → `waitForExit(slirpPid)` → SIGKILL 兜底杀 children。`waitForExit` 默认超时 2000ms、50ms 轮询。启动失败的 catch 块是同一套顺序。
- holder 是 `unshare -Urnp --fork --kill-child=SIGTERM` 包装进程。util-linux 的 `unshare` 在 fork 前 `sigprocmask(SIG_BLOCK, {SIGINT, SIGTERM})`，**只在子进程里** `SIG_SETMASK` 恢复：父进程永久阻塞这两个信号，且不安装 handler。实测该进程 `/proc/<pid>/status` 为 `SigBlk=0x4002`（含 SIGTERM）、`SigCgt=0`，SIGTERM 后 3s 仍存活。
- `--kill-child=signame` 的实现位置是**子进程**：fork 后由子进程 `prctl(PR_SET_PDEATHSIG, signame)`，并用 `pidfd_open` 做「fork 后父进程已死」的竞态检查。语义是「unshare 死亡时子进程收到 signame」，而不是「unshare 收到信号时转发给子进程」。
- 现状实测（unsandboxed 真实路径，`echo 1`）：起栈 41ms、执行 37ms、**停栈 2012ms**；对照把终止 holder 的信号换成 SIGKILL：unshare 10ms 退出、node init 101ms 退出、slirp 随之退出，无残留。
- 网络栈是每条命令现建现停（`sandbox.ts` 的 `runInSandbox` 里 `createNetworkStack` + `finally { stack.stop() }`），因此这 2s 是每条命令的固定成本。

## Goals / Non-Goals

**Goals:**

- 每条命令的沙盒停栈开销回到毫秒级，端到端回到 ~0.18s 量级。
- 启动失败路径的清理同样不再白等固定超时。
- 不削弱既有的 namespace 泄漏保障：pid ns init 退出触发内核清理、宿主崩溃走 stdin EOF。
- 让 spec / 注释里对 `--kill-child` 的描述与 util-linux 实际行为一致。

**Non-Goals:**

- 不恢复「session 级常驻网络栈」：现建现停是历史上有意选择的行为（按当时实测 ~140ms 开销换来 allowlist 变更即时生效），本次只消除误加进去的固定等待。
- 不改 allowlist / 审批 / fs 轴 / bwrap argv 组装的任何行为。
- 不为缩短 mihomo 的优雅退出时间做工作（~100ms 属预期成本）。

## Decisions

**D1：终止 holder 用 SIGKILL，而不是继续用 SIGTERM。**

SIGKILL 不可被阻塞或忽略，必然送达；unshare 当场退出后，PDEATHSIG 把 SIGTERM 交给 pid ns init（node holder），init 走既有的 SIGTERM handler 优雅停 mihomo 再退出，内核随后清理 pid ns、关闭 exit-fd 写端、slirp 收 HUP 退出。

考虑过的替代方案：

- _保留 SIGTERM，只把 `waitForExit` 超时调小_：治标。清理仍依赖尾部 SIGKILL 兜底，且仍是一次固定等待，超时值还要按环境反复调。
- _直接 SIGKILL pid ns init_：更快，但跳过 init 的优雅退出（mihomo 只能被内核强杀，cache.db 不落盘），且 init 死后仍要等 unshare 的 `waitpid` 返回，省不了多少。
- _改用 SIGHUP / SIGUSR1 杀 holder_：这些信号当前也确实能杀死 unshare（无 handler），但属于「碰巧能行」——将来 unshare 装上 handler 就失效；SIGKILL 无此不确定性。
- _对进程组整体 SIGKILL_：失去「由 init 退出触发内核清理」的语义保障，且会波及同组的其他进程。

**D2：slirp4netns 仍用 SIGTERM，`readChildPids` + SIGKILL 兜底保留。**

slirp 实测 60ms 内响应 SIGTERM 退出，且它持有 tap fd、pin 住 netns，先杀它可避免与 exit-fd HUP 的收尾时序竞争（原有顺序不变）。children 的 SIGKILL 兜底保留，用于 PDEATHSIG 意外未生效的场景。

**D3：`waitForExit` 的 2000ms 超时保留为兜底，不改轮询实现。**

改掉信号后正常路径下它 ~50ms 内返回，超时值退化为纯安全网；为一个不再触发的分支引入事件驱动等待属于无收益的重构。

**D4：`stackFinalizer` 的 GC 兜底同步换成 SIGKILL。**

那里同样是 SIGTERM，同样打不通 holder；不改会留下「GC 路径仍泄漏到 2s 后由内核清理」的不一致。

**D5：文档与规范按「每条命令现建现停 + holder 需用不可阻塞信号终止」同步。**

`src/bwrap/README.md` 的「一个 session 内 N 条命令复用同一套常驻栈」与生命周期表、`src/bwrap/sandbox.ts` 的「启动约 140ms」注释、`openspec/specs/bwrap-network/spec.md` Implementation 里 `--kill-child` 的描述都按实测与 util-linux 实际行为改写。

## Risks / Trade-offs

- [unshare 在设置 PDEATHSIG 之前就被 SIGKILL] → util-linux 子进程内的 pidfd 竞态检查会自行退出；此外 stop() 保留 `readChildPids` + SIGKILL 兜底。
- [SIGKILL 使 unshare 跳过自身的退出路径] → unshare 在父进程侧只做 `waitpid`，没有清理职责；网络栈清理由 init 退出触发内核完成，无副作用。
- [stop() 不再等待 init 真正退出] → 与改动前一致（原本也不等待 children 的 SIGKILL 生效）；下一条命令使用全新的 userns/netns，无共享状态。
- [集成测试需真实 mihomo / slirp4netns / unshare，常规 CI 跑不了] → 断言放在 `RUN_NETSTACK_INTEGRATION=1` 的手动测试里，阈值取 1s 级避免真实环境抖动导致假失败。
- [SIGKILL 让 mihomo 失去最后的 flush 机会] → 实际不会：SIGKILL 只作用于 unshare 包装进程，SIGTERM 仍会经 PDEATHSIG 送到 init，mihomo 的退出路径不变（实测 init 101ms 退出，与优雅路径一致）。

## Migration Plan

无需数据或配置迁移。扩展行为随重启 pi agent 生效；回滚即还原信号与文档改动。
