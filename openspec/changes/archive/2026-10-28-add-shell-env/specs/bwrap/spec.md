# Spec Delta

## ADDED Requirements

### Requirement: 命令执行环境

Bash 工具执行命令时的环境 MUST 由执行层自己的基础值与该会话配置的 `personalExtensions.shell.env` 合并而成，且 MUST 对沙箱内执行与不经沙箱的本地执行两条路径一致生效。同一变量名同时存在于两边时，`shell.env` 的值优先。

#### Scenario: 未配置时不改变现有环境

- **WHEN** 未配置 `personalExtensions.shell.env`
- **THEN** 沙箱内命令的环境仍是 `HOME` / `SHELL` / `TERM` / `LANG` / `PATH` 这组基础值（再由 `bash -lc` 的 profile 调整），本地执行路径的环境与不注入时完全相同

#### Scenario: 沙箱内命令拿到注入的变量

- **WHEN** `shell.env` 含 `{ "GIT_EDITOR": "true" }`，且命令在沙箱内执行
- **THEN** 命令进程中 `GIT_EDITOR` 为 `true`（`git commit` / `git rebase -i` 不再拉起真实编辑器）

#### Scenario: 非沙箱路径同样拿到注入的变量

- **WHEN** `shell.env` 含 `{ "GIT_EDITOR": "true" }`，且本次执行不经沙箱（Windows、审批通过的全权限、或 fs 与 network 都是 `allow-all`）
- **THEN** 命令进程中 `GIT_EDITOR` 同样为 `true`

#### Scenario: 注入值覆盖基础值

- **WHEN** `shell.env` 里的变量名与基础环境同名（如 `LANG`）
- **THEN** 该变量以 `shell.env` 的值为准

#### Scenario: 预览与执行的环境合并规则一致

- **WHEN** 同一组 env 分别用于预览一条沙箱命令与实际执行该命令
- **THEN** 预览给出的环境与实际 spawn 的环境一致（两者由同一段组装产生）

#### Scenario: 其它工具不受影响

- **WHEN** 配置了 `shell.env`
- **THEN** 只有 bash 工具的进程环境变化，LSP 服务器、gh、codemode 脚本等其它工具的子进程环境不变
