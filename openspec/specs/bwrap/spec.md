# bwrap Specification

## Purpose

基于 bubblewrap 的 OS 级沙箱，为所有 bash 命令提供文件系统隔离：沙箱内的命令只能写入配置允许的路径，`.pi` / `.agent` / `.git` 等关键目录在可写模式下始终只读（fs 完全放开时这层保护随之取消），需要超出沙箱权限的命令经审批后以全权限执行。文件系统策略与网络策略是两个正交的轴，可任意组合；网络轴见 `openspec/specs/bwrap-network/spec.md`。

## Requirements

### Requirement: 沙箱模式控制可写边界

bash 命令在沙箱内执行，可写文件系统边界由 **fs 模式**决定。fs（`readonly` | `workspace-write` | `allow-all`）与 network（`block` | `limited` | `allow-all`）是两个正交的轴，可任意组合，运行时经 `/bwrap-fs-*` / `/bwrap-network-*` 命令分别切换（固定沙箱的子代理不注册这些命令，见 spawn-agent spec）。

#### Scenario: workspace-write 模式允许写 workspace

- **WHEN** fs 模式为 `workspace-write` 且命令写入 workspace 内路径
- **THEN** 写入成功（workspace 与 `/tmp` 可写）

#### Scenario: readonly 模式禁止任何写入

- **WHEN** fs 模式为 `readonly` 且命令尝试写入文件
- **THEN** 写入被拒绝（文件系统只读，默认与配置的可写路径都清空）

#### Scenario: 两个轴都 allow-all 时不进沙箱

- **WHEN** fs 与 network **都**是 `allow-all`
- **THEN** 命令以完整文件系统权限直接本地执行，不经 bwrap

#### Scenario: 仅 fs 放开仍需沙箱

- **WHEN** fs 为 `allow-all` 而 network 不是（或反之）
- **THEN** 命令仍进 bwrap：fs `allow-all` 把整棵根挂成可写，`.pi` / `.agent` / `.git` 的保护绑定随之取消

#### Scenario: network 轴独立生效

- **WHEN** network 为 `block` / `limited` / `allow-all`
- **THEN** 分别为断网 / 仅 allowlist 内目标可直连 / 不限制；`limited` 的网络栈见 `openspec/specs/bwrap-network/spec.md`

### Requirement: 提权审批

模型需要全权限（`dangerouslyDisableSandbox: true`）时，命令按审批规则判定或需用户确认。

#### Scenario: 命中 allow 规则自动放行

- **WHEN** 命令命中 `approvalRules` 中的 `allow` 规则
- **THEN** 直接以全权限执行，不弹确认框

#### Scenario: 命中 deny 规则直接拒绝

- **WHEN** 命令命中 `approvalRules` 中的 `deny` 规则
- **THEN** 命令被拒绝执行

#### Scenario: 未命中规则需用户确认

- **WHEN** 命令未命中任何审批规则
- **THEN** 弹出确认框，用户批准后以全权限执行

#### Scenario: 含输出重定向的命令不自动放行

- **WHEN** 命令含文件输出重定向（`>` / `>>` / `&>` 等）
- **THEN** 即使命令文本匹配 allow 规则也不自动放行（防止 `echo *` 类规则被 `echo '' > file` 带过）

### Requirement: 关键目录保护

`.pi`、`.agent` 与 `.git` 目录在可写模式下也始终只读（fs `allow-all` 时整棵根可写，保护随之取消）。

#### Scenario: 保护目录在 workspace-write 下仍只读

- **WHEN** 沙箱处于 `workspace-write` 模式且命令尝试写入 `.pi` / `.agent` / `.git`
- **THEN** 写入被拒绝

#### Scenario: 嵌套仓库的 .git 也受保护

- **WHEN** workspace 根不是 git 仓库且存在嵌套仓库
- **THEN** 递归扫描发现的各 `.git` 目录均只读（跳过 `node_modules`、`.venv` 等包目录）

### Requirement: 配置分层合并

配置文件项目优先于全局，支持自定义可写路径、隐藏路径、网络 allowlist、审批规则与额外 bwrap 参数。

#### Scenario: 项目配置覆盖全局

- **WHEN** 项目 `.pi/sandbox.json` 与全局 `~/.pi/agent/sandbox.json` 都存在
- **THEN** 项目配置优先生效（可写路径覆盖、额外可写路径合并）

#### Scenario: 不存在的路径自动忽略

- **WHEN** 配置的可写或保护路径不存在
- **THEN** 对应 bwrap 挂载项被忽略，命令正常执行（`--*-bind-try` 语义）

#### Scenario: 模式可经命令切换

- **WHEN** 运行 `/bwrap-fs-readonly`、`/bwrap-fs-workspace-write`、`/bwrap-fs-allow-all`、`/bwrap-network-block`、`/bwrap-network-limited`、`/bwrap-network-allow-all`
- **THEN** 对应轴当前会话的取值即时切换（`/bwrap` 查看现状，`/bwrap-reload` 重读配置并重建网络栈）

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

## Implementation

沙箱执行路径：`BwrapRuntime.execute` → `runInSandbox`（`src/bwrap/sandbox.ts`）→ 组装 bwrap 调用（`buildBwrapInvocation`）→ 执行（`execInvocation`），两者都在 `src/bwrap/exec.ts`；`network: "limited"` 模式先经 `createNetworkStack`（`src/bwrap/core.ts`）建网络栈，执行时再由执行层加上 `nsenter` 前缀进入 holder 的 userns + netns。配置解析（`core.ts`）与执行（`exec.ts`）分开：前者不碰进程，后者不知道配置从哪来。

- **bwrap argv 组装**：`--ro-bind / /` 只读挂载整个根，然后按配置叠加 `--bind-try`（可写路径，不存在自动忽略）、`--ro-bind-try`（保护目录）、`--tmpfs` / `/dev/null` 覆盖（denyPaths）；`--unshare-user --unshare-pid` 提供 user/pid namespace 隔离。完整命令行（含 `nsenter` 前缀）由 `invocationArgv` 一处产出，`--print-args` 预览与实际执行共用它。
- **执行路径的错误语义**：`execInvocation` 是唯一的子进程生命周期实现——命令以独立进程组启动，超时与取消都终止整组，超时抛 `TimeoutError`（`message` 为 `timeout:<秒>`）、取消抛 `signal.reason`（默认 AbortError）；启动失败立即结束并清掉已排定的超时定时器。经 netns 与不经 netns 两条路径共用它，语义不因网络模式而变。
- **模式解析**（`resolveBwrap`）：fs 与 network 是两个独立轴；仅当两者都为 `allow-all` 时 `bwrapEnabled` 为 false、命令不经 bwrap 直接本地执行。`readonly` 清空可写路径，`workspace-write` 用配置的可写路径，`allow-all` 把整棵根挂成可写（保护绑定随之取消）。headless 会话不强制模式，只在需要用户审批时按拒绝处理（无 UI 可弹框）。
- **审批**：`dangerouslyDisableSandbox` 命令按 `approvalRules` 判定——用 tree-sitter 解析命令并按 BashArity 生成模式（`git checkout main` → `git checkout *`），含嵌套 `$(...)` 内的命令，规则后写优先；含输出重定向（`>` / `>>` / `&>`）的命令即使规则全匹配也不自动放行；未命中弹确认框。
- **配置加载**：`~/.pi/agent/sandbox.json`（全局）与 `.pi/sandbox.json`（项目）合并，项目优先；fs / network 可用 `/bwrap-fs-*` / `/bwrap-network-*` 命令运行时切换。固定沙箱（子代理 frontmatter 声明的配置）不注册 `/bwrap-*` 命令，避免切模式放宽声明的沙箱。

涉及文件：`src/bwrap/core.ts`、`src/bwrap/exec.ts`、`src/bwrap/sandbox.ts`、`src/bwrap/runtime.ts`。
