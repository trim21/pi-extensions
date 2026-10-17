# Spec Delta

## MODIFIED Requirements

### Requirement: 沙箱模式控制可写边界

bash 命令在沙箱内执行，可写文件系统边界由 **fs 模式**决定。fs（`readonly` | `workspace-write` | `allow-all`）与 network（`block` | `limited` | `allow-all`）是两个正交的轴，可任意组合，运行时经 `/bwrap-fs-*` / `/bwrap-network-*` 命令分别切换（固定沙箱的子代理不注册这些命令，见 spawn-agent spec）。`readonly` 时 MUST 忽略全部可写路径：`writablePaths` 与 `extraWritablePaths` 都清空，命令不能写入任何路径。

#### Scenario: workspace-write 模式允许写 workspace

- **WHEN** fs 模式为 `workspace-write` 且命令写入 workspace 内路径
- **THEN** 写入成功（workspace 与 `/tmp` 可写）

#### Scenario: readonly 模式禁止任何写入

- **WHEN** fs 模式为 `readonly` 且命令尝试写入文件
- **THEN** 写入被拒绝（文件系统只读，默认、配置与额外可写路径都清空）

#### Scenario: readonly 模式忽略额外可写路径

- **WHEN** fs 模式为 `readonly` 且配置里声明了 `fs.extraWritablePaths`
- **THEN** 这些路径 MUST NOT 以可写方式挂载，写入仍被拒绝；切回 `workspace-write` 后配置值重新生效

#### Scenario: 两个轴都 allow-all 时不进沙箱

- **WHEN** fs 与 network **都**是 `allow-all`
- **THEN** 命令以完整文件系统权限直接本地执行，不经 bwrap

#### Scenario: 仅 fs 放开仍需沙箱

- **WHEN** fs 为 `allow-all` 而 network 不是（或反之）
- **THEN** 命令仍进 bwrap：fs `allow-all` 把整棵根挂成可写，`.pi` / `.agent` / `.git` 的保护绑定随之取消

#### Scenario: network 轴独立生效

- **WHEN** network 为 `block` / `limited` / `allow-all`
- **THEN** 分别为断网 / 仅 allowlist 内目标可直连 / 不限制；`limited` 的网络栈见 `openspec/specs/bwrap-network/spec.md`
