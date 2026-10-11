# Proposal

## Why

当前沙箱执行层（`src/bwrap/`，约 3300 行 TS）有几个结构性妥协，都源于"用 JS 进程扮演系统角色"：

1. **用 node 进程顶 PID namespace 的 init**：`holder.js` 存在的唯一理由是"需要有人在目标 namespace 里持有 netns 并 spawn mihomo"，它还要顺带处理 stdin EOF、exit-fd、信号转发——这些本该是 init 的职责。
2. **包装进程 + nsenter**：每个 namespace 由 `unshare` 包装进程持有（它永久阻塞 SIGINT/SIGTERM，终止只能 SIGKILL），命令执行前还要 `nsenter -U -n --preserve-credentials` 从外面进入。
3. **fd 传递依赖 Node 私有 API**：exit-fd 要从 `holder.stdio[3]._handle.fd` 这种 `stdio[3].fd 恒为 undefined` 的私有字段里取。
4. **终止只能按 pid 发信号**：Node/libuv 没有 pidfd（实测 `uv_process_kill` 就是 `kill(pid, sig)`），检查与发信号之间不是原子的，只能用"fd 通道 + 极小窗口"折中。

Go 可以直接做这些事：`clone(CLONE_NEW*)` 建 namespace、pidfd（`pidfd_open`/`pidfd_send_signal`/`poll`）管理进程、`ExtraFiles` 传递 fd、自己当 PID 1。这个 change 交付一个**独立的 Go CLI 原型**，验证"换成原生实现能替掉多少代码、能消除哪些妥协"，并**先不与现有 TS 路径接入**。

## What Changes

- 新增顶层目录 `native/`（不在 npm 包 `files` 里，不影响发布），内含一个无第三方依赖的 Go 模块，产物是单一 CLI：
  ```bash
  sandbox run --policy '<json>' --command 'curl -sS https://pypi.org/simple/'
  sandbox run --policy-base64 <base64> --command '...' --timeout 30
  sandbox run --policy @policy.json --command '...' --print-args
  ```
- 策略（policy）是自描述的 JSON，包含 fs 绑定（readonly/readwrite/deny）、网络模式与 allowlist、外部命令路径（bwrap/mihomo/slirp4netns）、mtu、uid/gid、超时——与 pi 的 `personalExtensions`/`ResolvedBwrap` 解耦，TS 侧将来只需把它序列化过来。
- 进程模型：CLI 自己 `clone(CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNS|CLONE_NEWNET)` 出 init 进程（新 namespace 内的 PID 1，直接执行 bwrap），父进程是 supervisor（起 slirp4netns、持有 pidfd、转发输出、超时/取消时用 `pidfd_send_signal` 终止）。
- 终止语义：**所有信号都经 pidfd 发出**（不再有 TOCTOU），等待退出用 poll(pidfd)，不复用 Node/libuv 的 `kill(2)` 路径。
- 明确不做：不接入 TS 路径、不改 `src/`、不改发布流程、不实现完整的 fs 保护策略（`PROTECTED_DIRS`、`.git` 递归保护、审批规则、输出截断、pendant 面板等仍由 TS 层负责）。

## Capabilities

### New Capabilities

（无）：这是不接入的实验性原型，不改变任何现有行为与已发布契约。

### Modified Capabilities

（无）

## Impact

- 新增：`native/`（Go 模块、CLI 源码、README 说明用法与已知差异）。
- 不改动：`src/`、`test/`、`package.json`（`files` 不含 `native/`）、CI、发布流程。
- 观测手段：手工运行 CLI 对比与 TS 实现的差异，并统计可迁移代码量（预算：`src/bwrap/` 约 1050 行可搬，Go 侧约 600–900 行）。
