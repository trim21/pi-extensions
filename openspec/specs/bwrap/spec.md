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

## Implementation

沙箱执行路径：`BwrapRuntime.execute` → `runInSandbox`（`src/bwrap/sandbox.ts`）→ 组装 bwrap argv（`src/bwrap/core.ts`）→ 执行；`network: "limited"` 模式额外经 `createNetworkStack` 建网络栈。

- **bwrap argv 组装**：`--ro-bind / /` 只读挂载整个根，然后按配置叠加 `--bind-try`（可写路径，不存在自动忽略）、`--ro-bind-try`（保护目录）、`--tmpfs` / `/dev/null` 覆盖（denyPaths）；`--unshare-user --unshare-pid` 提供 user/pid namespace 隔离。
- **模式解析**（`resolveBwrap`）：fs 与 network 是两个独立轴；仅当两者都为 `allow-all` 时 `bwrapEnabled` 为 false、命令不经 bwrap 直接本地执行。`readonly` 清空可写路径，`workspace-write` 用配置的可写路径，`allow-all` 把整棵根挂成可写（保护绑定随之取消）。headless 会话不强制模式，只在需要用户审批时按拒绝处理（无 UI 可弹框）。
- **审批**：`dangerouslyDisableSandbox` 命令按 `approvalRules` 判定——用 tree-sitter 解析命令并按 BashArity 生成模式（`git checkout main` → `git checkout *`），含嵌套 `$(...)` 内的命令，规则后写优先；含输出重定向（`>` / `>>` / `&>`）的命令即使规则全匹配也不自动放行；未命中弹确认框。
- **配置加载**：`~/.pi/agent/sandbox.json`（全局）与 `.pi/sandbox.json`（项目）合并，项目优先；fs / network 可用 `/bwrap-fs-*` / `/bwrap-network-*` 命令运行时切换。固定沙箱（子代理 frontmatter 声明的配置）不注册 `/bwrap-*` 命令，避免切模式放宽声明的沙箱。

涉及文件：`src/bwrap/core.ts`、`src/bwrap/sandbox.ts`、`src/bwrap/runtime.ts`。
