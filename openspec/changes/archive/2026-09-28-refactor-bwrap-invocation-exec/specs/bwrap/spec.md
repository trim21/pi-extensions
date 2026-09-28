# bwrap 规格变更

## ADDED Requirements

### Requirement: 沙箱命令的预览与执行一致

`pnpm sandbox --print-args` 给出的预览 MUST 与实际执行的命令行逐项一致：两者由同一段组装产生，且包括 `network: "limited"` 模式下前置的 `nsenter -U -n --preserve-credentials -t <holderPid> --` 前缀。holder 尚未启动时，预览 MUST 以占位符标出 holder pid 的位置并标记该命令需要网络栈。系统 MUST NOT 出现「预览的是一回事、执行的是另一回事」的漂移。

需要网络栈与不需要网络栈两条执行路径 MUST 以相同方式处理超时、中断与启动失败：超时 MUST 以 `TimeoutError` 结束（`message` 为 `timeout:<秒>`）并终止整个进程组；中断 MUST 以 `signal.reason` 结束（默认 `name=AbortError`）并终止整个进程组；子进程启动失败 MUST 立即以该错误结束，且 MUST NOT 残留已排定的超时定时器或悬挂的等待。

#### Scenario: 预览直接执行

- **WHEN** 预览一条不需要网络栈的命令（fs 或 network 至少一个不是 `allow-all`，且 network 不是 `limited`）
- **THEN** argv 为 `[bwrap, ...args, "--", <shell>, "-lc", <command>]`，结果标记为不需要网络栈

#### Scenario: 预览经网络栈执行

- **WHEN** 预览一条 `network: "limited"` 的命令
- **THEN** argv 前置 `nsenter -U -n --preserve-credentials -t <holderPid> --`，结果标记为需要网络栈；未提供 holder pid 时该位置为占位符

#### Scenario: 预览与实际执行同一条命令行

- **WHEN** 同一份配置与同一条命令分别走预览与实际执行（`network: "limited"`）
- **THEN** 实际 spawn 的 argv 与预览逐项一致，唯一差异是占位符被替换为真实 holder pid

#### Scenario: 超时语义在两条路径上一致

- **WHEN** 经网络栈执行的命令与直接执行的命令分别超时
- **THEN** 两者都以 `TimeoutError`（`message` 为 `timeout:<秒>`）结束，且各自终止整个进程组

#### Scenario: 中断语义在两条路径上一致

- **WHEN** 经网络栈执行的命令与直接执行的命令分别被调用方中断
- **THEN** 两者都以 `signal.reason` 结束（默认 `name=AbortError`），且各自终止整个进程组

#### Scenario: 启动失败立即结束

- **WHEN** 子进程启动失败（如 bwrap 或 nsenter 不存在）
- **THEN** 执行立即以该错误结束，不残留超时定时器或悬挂的等待
