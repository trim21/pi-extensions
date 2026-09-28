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

模型需要全权限（`dangerouslyDisableSandbox: true`）时，命令 MUST 由审批规则集判定：链上任一命令命中 `deny` 规则即整体拒绝；链上所有命令都命中 `allow` 规则才整体自动放行；含写入文件的重定向（`>` / `>>` / `&>` 等）的命令即使规则全匹配也不自动放行；其余情况弹确认框交用户决定。同一条命令同时命中多条规则时，规则数组中靠后的那条决定其动作（项目规则排在全局规则之后）。`/bwrap-deny-request` 生效或运行在固定沙箱时，非沙箱请求直接拒绝，规则与确认框都不参与。

#### Scenario: 命中 allow 规则自动放行

- **WHEN** 命令的每条子命令（含 `$(...)` 与管道两端）都命中 `approvalRules` 中的 `allow` 规则
- **THEN** 直接以全权限执行，不弹确认框

#### Scenario: 链上有一条命令未命中 allow 规则则需确认

- **WHEN** 命令链中有一条子命令没有命中任何 `allow` 规则
- **THEN** 弹出确认框（未允许的命令不会被同链的其他规则带过）

#### Scenario: 命中 deny 规则直接拒绝

- **WHEN** 命令链中任一子命令命中 `approvalRules` 中的 `deny` 规则
- **THEN** 命令被拒绝执行，不弹确认框

#### Scenario: 后写的规则优先

- **WHEN** 同一条命令同时命中先出现的 `allow` 规则与后出现的 `deny` 规则（或反之）
- **THEN** 以数组中靠后的那条规则为准；项目配置的规则排在全局配置的规则之后

#### Scenario: 含输出重定向的命令不自动放行

- **WHEN** 命令含文件输出重定向（`>` / `>>` / `&>` 等）
- **THEN** 即使命令文本匹配 `allow` 规则也不自动放行（防止 `echo *` 类规则被 `echo '' > file` 带过）

#### Scenario: 未命中规则需用户确认

- **WHEN** 命令未命中任何审批规则
- **THEN** 弹出确认框，用户批准后以全权限执行

#### Scenario: 请求被拒绝时规则不参与

- **WHEN** 用户已执行 `/bwrap-deny-request`，或当前运行在固定沙箱（子代理声明的配置）中，且模型请求非沙箱执行
- **THEN** 请求直接按拒绝处理，不弹确认框；即使命令命中 `allow` 规则也不放行

### Requirement: 审批规则的持久化

用户在审批确认框的子菜单里勾选的命令模式，写入项目配置文件 `.pi/sandbox.json` 的 `approvalRules`（`allow`），并在本会话内立即生效、无需重载配置。写入 MUST 保留该配置文件中与审批规则无关的既有内容，包括本版本不认识的字段。子菜单只列出该命令的候选模式中尚未被 `allow` 规则覆盖的那些；用户在确认框选择「Run this in sandbox」时不写入任何规则。

#### Scenario: 勾选的模式写入项目配置并立即生效

- **WHEN** 用户在确认框勾选 `git status *` 并选择放行
- **THEN** `.pi/sandbox.json` 的 `approvalRules` 追加 `{ "action": "allow", "pattern": "git status *" }`，且本会话内后续同模式命令不再弹确认框

#### Scenario: 写入保留配置文件的其余内容

- **WHEN** 项目配置文件里已有其他字段（如 `fs`、`network` 配置或不认识的字段）
- **THEN** 写入后这些内容原样保留

#### Scenario: 只列出尚未允许的模式

- **WHEN** 命令链中一部分子命令的模式已被 `allow` 规则覆盖
- **THEN** 子菜单只列出未被覆盖的模式，已允许的不重复展示、也不重复写入

#### Scenario: 拒绝提权时不写入规则

- **WHEN** 用户在确认框选择「Run this in sandbox」（拒绝提权、改为沙箱内执行）
- **THEN** 即使在子菜单勾选过模式，也不写入任何规则

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
- **审批**：`dangerouslyDisableSandbox` 命令的判定由 `createApprovalRuleSet`（`src/bwrap/approval-rules.ts`）独占——`evaluate` 给出 allow / deny / 交人审（用 tree-sitter 解析命令并按 BashArity 生成模式，`git checkout main` → `git checkout *`，含嵌套 `$(...)` 内的命令；deny 优先、allow 需全链命中、含输出重定向 `>` / `>>` / `&>` 时不自动放行、单条命令上靠后的规则优先）；审批子菜单只列 `pendingPatterns`（候选模式去重后仍未命中 allow 的）；用户勾选后由 `addAllowRules` 追加并调用注入的 `persist` 落盘。规则集的三条协作方（规则 getter、候选模式生成、持久化实现）都由 runtime 注入：规则 getter 让它跟随 `resolved` 的替换（`/bwrap-reload`、`/bwrap-fs-*`）而不必重建，持久化实现把项目配置文件写回与缓存刷新留在 runtime。
- **配置加载**：`~/.pi/agent/sandbox.json`（全局）与 `.pi/sandbox.json`（项目）合并，项目优先；fs / network 可用 `/bwrap-fs-*` / `/bwrap-network-*` 命令运行时切换。固定沙箱（子代理 frontmatter 声明的配置）不注册 `/bwrap-*` 命令，避免切模式放宽声明的沙箱。

涉及文件：`src/bwrap/core.ts`、`src/bwrap/exec.ts`、`src/bwrap/sandbox.ts`、`src/bwrap/runtime.ts`。
