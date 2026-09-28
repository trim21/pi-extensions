# Proposal: refactor-bwrap-invocation-exec

## Why

「一次 bwrap 调用」这个概念在 bwrap 子系统里被声明两次、argv 组装写了三份、子进程生命周期实现了两份且已经漂移：`core.ts` 定义 `BwrapInvocation` 并在 `createBwrapBashOperations` 里起进程，`network-stack.ts` 另定义 `NetworkStackExecOptions` 并在 `NetworkStack.exec` 里再起一次进程（`nsenter` 前缀 + 同样的超时/中断处理），`sandbox.ts` 的 `previewSandboxCommand` 为了 `--print-args` 又手抄了一遍 `nsenter` argv。

三处副本的成因是 seam 放错位置：`core.ts` 已经 import `network-stack.ts`，网络栈反向 import 调用类型会成环，于是调用方只能把 invocation 拆成 6 个字段再传（`core.ts:577-587`）。两份生命周期已经不同——`network-stack.ts:419-466` 有 `settled` 守卫、`error` 与 `close` 都判、错误路径清理定时器；`core.ts:598-630` 没有守卫、`error` 路径不清定时器、`killChild` 的参数类型也不同。两份真实 spawn 的 timeout/abort 语义在常规 CI 下都没有覆盖（`bwrap-runtime.test.ts:17-20` 把 `createBwrapBashOperations` mock 成本地执行，`network-stack` 的 exec 只在环境变量门控的集成测试里跑）。

## What Changes

- 新增 `src/bwrap/exec.ts`：持有 `BwrapInvocation`、`buildBwrapInvocation`、`invocationArgv`（唯一一处组装完整命令行，含 `nsenter` 前缀）与 `execInvocation`（唯一的子进程生命周期实现：进程组终止、`TimeoutError` / `AbortError` 分类、`settled` 守卫、错误路径清理定时器），以及 `createBwrapBashOperations`。
- `src/bwrap/core.ts` 收敛为配置层：schema / 加载 / 合并 / `resolveBwrap` / 路径查找 / `buildBwrapArgs` / `createNetworkStack`。不再持有 spawn 与 `BashOperations`。
- `NetworkStack` 不再暴露 `exec`，只保留 `holderPid` 与 `stop()`：网络栈负责 namespace 生命周期，命令怎么进 netns 归 `exec.ts`。
- `previewSandboxCommand` 改用同一份组装，`nsenter` 前缀与 holder pid 的呈现不再是手抄副本。
- `BwrapInvocation` 去掉无人读取的 `cwd` 字段（`buildBwrapInvocation` 的 `cwd` 参数随之去掉）：interface 只保留调用方真正需要的字段。
- 统一后的生命周期采用 `network-stack.ts` 那一版语义（`settled` 守卫 + 错误路径清理定时器）。这是唯一一处行为变化：direct 路径在 spawn 失败时不再残留已排定的超时定时器。
- 无 **BREAKING**：`BwrapInvocation` / `buildBwrapInvocation` / `getBwrapConfigPaths` 等只在仓库内部使用，未对外承诺。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap`: 新增「沙箱命令的预览与执行一致」需求——把当前只靠注释与手抄代码维持的 `--print-args` 一致性，和两条执行路径上超时/中断/启动失败的错误语义，写成可测试的行为契约。本次改动本身不改用户可见行为（唯一例外见 What Changes 最后一条），需求是给这次重构立下验收标准。

## Impact

- 代码：`src/bwrap/exec.ts`（新增）、`src/bwrap/core.ts`、`src/bwrap/network-stack.ts`、`src/bwrap/sandbox.ts`、`src/bwrap/README.md`。
- 规范：`openspec/specs/bwrap/spec.md` 与 `openspec/specs/bwrap-network/spec.md` 的 Implementation 段（执行路径与涉及文件随结构改写）。
- 测试：`test/bwrap-sandbox.test.ts`、`test/bwrap-runtime.test.ts`（`createBwrapBashOperations` 的 mock 目标模块变化）、`test/bwrap-netstack-integration.test.ts`（当前直接调 `stack.exec`，改走新的执行入口）；新增「预览 argv 与实际 spawn argv 逐项一致」与「direct 路径 spawn 失败不留定时器」的断言。
- 不涉及配置格式、依赖、CLI 参数或用户可见行为的变更；`network: block` / `allow-all` / `limited` 三种模式的外部行为不变。
