# Design

## Context

动机见 `proposal.md` - Why。这里只列影响方案的现状与约束。

- `src/bwrap/core.ts` 同时承担两件事：配置（schema / 加载 / 合并 / `resolveBwrap` / 路径查找 / `buildBwrapArgs`）与执行（`BwrapInvocation`、`buildBwrapInvocation`、`bwrapArgv`、`createBwrapBashOperations` 里的 spawn 与生命周期）。
- `src/bwrap/network-stack.ts` 的 `NetworkStack.exec` 用 `NetworkStackExecOptions`（8 个字段，等于 `BwrapInvocation` 拆开后的形状）自己拼 `nsenter ... -- <bwrap> ... -- <shell> -lc <command>` 并再实现一次生命周期。这个形状是 seam 位置的产物：`core.ts` 已 import `network-stack.ts`（`core.ts:15-20`），类型反向 import 会成环。
- `src/bwrap/sandbox.ts` 的 `previewSandboxCommand` 手抄了一段 `nsenter` argv（`sandbox.ts:180-190`），靠注释与 `network-stack.ts` 保持一致。
- 两份生命周期已经不同：`network-stack.ts:419-466` 有 `settled` 守卫、`error` 与 `close` 都判且错误路径不残留定时器；`core.ts:598-630` 无守卫、`error` 路径不清定时器。
- 真实 spawn 的 timeout/abort 只被本地执行（`unsandboxed`）与 `RUN_NETSTACK_INTEGRATION=1` 门控的集成测试覆盖；`test/bwrap-runtime.test.ts:17-20` 把 `createBwrapBashOperations` mock 成本地执行。
- `BwrapInvocation.cwd` 与 `buildBwrapInvocation` 的 `cwd` 参数全仓无读取点（唯一赋值处是 `core.ts:536`，消费者只用 `file` / `args` / `shell` / `command` / `env` / `needsNetworkStack`）。
- `TimeoutError` 定义在 `network-stack.ts:13-18`，唯一 import 方是 `core.ts:19`；`runtime.ts` 与 `bin/sandbox.ts` 只按 `name` / `message` 前缀识别，不 import 该类。

## Goals / Non-Goals

**Goals:**

- `BwrapInvocation` 只声明一次，完整命令行的组装（含 `nsenter` 前缀）只有一处。
- 子进程生命周期只有一份实现，direct 与 netns 两条路径的超时 / 中断 / 启动失败语义完全相同。
- 执行层与网络栈层的依赖方向单向：网络栈不再需要知道 bwrap 参数怎么拼。
- 让「预览 == 执行」与两条路径错误语义一致成为可测试的契约（见 delta spec）。

**Non-Goals:**

- 不合并 direct 与 netns 两条执行路径本身：`nsenter` 前缀只有 `network: limited` 需要，强行统一成一个 adapter 会把网络栈的判断塞进执行层（网络栈是真实的第二个 adapter，符合「两个 adapter 才值得一条 seam」）。
- 不改 argv 内容、超时单位与默认值、`detached` / 进程组 kill 策略、`BashOperations` 的对外契约。
- 不引入 spawn 依赖注入或 abstraction：仓库既有测试风格是 module mock（`test/bwrap-runtime.test.ts`），且真实 spawn 的 `detached` / 进程组语义需要保真测试，注入会把它换成假实现。
- 不改网络栈的启动 / 停止 / namespace 生命周期（holder、slirp4netns、mihomo 部分）。

## Decisions

**D1：新增 `src/bwrap/exec.ts` 作为「invocation → 进程」的 module，依赖方向为 `core.ts` ← `exec.ts` ← `sandbox.ts`。**

`exec.ts` 持有 `BwrapInvocation`、`buildBwrapInvocation`、`invocationArgv`、`execInvocation`、`createBwrapBashOperations`；`core.ts` 只留配置层（含它自己需要的 `buildBwrapArgs` / `findBwrap`），不再 import 执行层，也不再有 `spawn`。`exec.ts` 依赖 `core.ts`（`ResolvedBwrap`、`buildBwrapArgs`、`findBwrap`）与 `network-stack.ts`（`NetworkStack` 类型），`network-stack.ts` 不依赖两者。环消失后 `NetworkStackExecOptions` 也随之消失。

考虑过的替代方案：

- _把 `BwrapInvocation` 移进 `network-stack.ts`，让 `exec` 直接吃它_：消除重复声明，但把「网络栈」变成通用执行器，且 `previewSandboxCommand` 还得反向依赖网络栈才能拼前缀——seam 移了位置，没变浅。
- _只在 core 里把 `nsenter` 前缀抽成函数，`network-stack.exec` 继续吃拆开的字段_：能消除手抄的 argv 副本，但两份生命周期仍在，本次最有价值的收敛（D3）落不了地。
- _让 `createBwrapBashOperations` 注入 spawn_：测试更好写，但与仓库既有 mock 风格冲突，且会为了可测性放宽真实语义（`detached: true` 的进程组 kill、`stdio` 形状）。

**D2：`NetworkStack` 去掉 `exec`，只保留 `holderPid` 与 `stop()`。**

命令怎么进 netns 是执行层的知识；网络栈的职责是「holder 在不在、活不活」。`createBwrapBashOperations(resolved, workspace, networkStack?)` 的签名保持不变，内部改读 `networkStack.holderPid`，`needsNetworkStack` 为真而 holder 缺失时仍抛原来的 `Network stack is not initialized for network limited mode`。

考虑过的替代方案：_`NetworkStack.exec` 保留为 `execInvocation` 的转发_——通道只剩 `holderPid` 一个字段的搬运，等于把 seam 留在原处。

**D3：生命周期统一采用 `network-stack.ts` 那一版的语义。**

`settled` 守卫（`error` 与 `close` 只结算一次）、`error` 路径也清理超时定时器、`killChild(pid)` 按 pid 杀进程组。这是本次唯一的行为变化：direct 路径在 spawn 失败时不再残留一个最长 `timeout` 秒的定时器（旧实现里 `close` 才清）。错误分类与消息不变：超时 `TimeoutError`（`message` = `timeout:<秒>`）、中断 `signal.reason`（默认 AbortError）。

**D4：完整命令行只有一处组装——`invocationArgv(invocation, nsenterPid?)`。**

`nsenterPid` 传 number 时进入该 holder 的 netns，传 string 时原样嵌入（预览用占位符 `HOLDER_PID_PLACEHOLDER`），不传即纯 bwrap argv。`execInvocation` 与 `previewSandboxCommand` 都调它，`bwrapArgv` 作为独立导出被它取代。

考虑过的替代方案：_`bwrapArgv` 与 `nsenterArgv` 两个函数_——调用方仍需自己判断该用哪个，判断逻辑就又是一处副本；_预览自己拼前缀_——正是当前的问题。

**D5：去掉 `BwrapInvocation.cwd` 与 `buildBwrapInvocation` 的 `cwd` 参数。**

全仓无读取点；命令执行目录由执行方（`execInvocation` 的 `cwd` 选项、`BashOperations.exec` 的 `cwd` 形参）决定，invocation 不该声明一个没人看的字段。interface 的宽度按调用方需要收缩。

**D6：`TimeoutError` 从 `network-stack.ts` 移到 `exec.ts`。**

迁移后唯一的抛出方是执行层，留在网络栈会让执行层为拿一个错误类而依赖网络栈的进程管理模块。`runtime.ts` / `bin/sandbox.ts` 按 `name` 识别，不受影响。

## Risks / Trade-offs

- [统一生命周期改变了 direct 路径的行为] → 变化限于「spawn 失败时不再残留定时器」，补一条断言（拒绝后 `process.getActiveResourcesInfo()` 不新增 `Timeout`），并在任务里先确认它能捕获旧行为。
- [测试 mock 的模块路径变化：`test/bwrap-runtime.test.ts:17` 对 `core.js` 的 `createBwrapBashOperations` mock] → 同步改 mock 目标为 `exec.js`，并跑该测试文件确认。
- [集成测试直接调 `stack.exec`] → 改走 `execInvocation` / `runInSandbox`；这些用例受 `RUN_NETSTACK_INTEGRATION=1` 门控，常规 CI 不跑，因此需要在 apply 阶段手动跑一次。
- [有仓库外的消费者 import `BwrapInvocation` / `buildBwrapInvocation` / `bwrapArgv`] → 这些是 bwrap 内部 interface，未在 README 或 spec 中承诺；包虽然发布到 npm，但对外可见面是 pi 扩展的工具与命令。
- [大型机械改动漏改一处 import 导致 `lib/write-guard` 之类间接路径失效] → `pnpm check`（tsc）+ `pnpm test` 兜底；本次不含动态 import。

## Migration Plan

无配置或数据迁移。改动随 pi agent 重启生效；回滚即还原 4 个源文件与测试。`src/bwrap/README.md` 的进程模型图里「pi 进程（network-stack.ts）」需随之改为执行层（`exec.ts`）。
