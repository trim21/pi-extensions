# Spec Delta

## MODIFIED Requirements

### Requirement: 命令执行环境

Bash 工具执行命令时的环境 MUST 由执行层自己的基础值（`HOME` / `SHELL` / `TERM` / `LANG` / `PATH`）与该会话配置的 `personalExtensions.shell.env` 合并而成，并用登录 shell（`shell -lc`）执行，由 profile 按当前工作目录重建 `PATH`。沙箱内执行与不经沙箱的本地执行两条路径 MUST 使用同一份环境构造与同一段 spawn 实现：交给 shell 的进程环境 MUST 逐项相同，差异 MUST 只有权限（bwrap 的只读挂载、netns、逐条审批），MUST NOT 因为继承父进程环境而在变量集合或工具版本解析上不同。同一变量名同时存在于基础值与 `shell.env` 时，`shell.env` 的值优先。profile 自身在沙箱的只读挂载 / 断网下走了不同分支（例如依赖写盘或联网的 shell hook）时，由此产生的变量差异属于 profile 行为，不由执行层保证——执行层保证的是交给 shell 的同一份环境与同一条登录 shell 路径。

#### Scenario: 未配置时不改变现有环境

- **WHEN** 未配置 `personalExtensions.shell.env`
- **THEN** 两条路径的命令环境都只有 `HOME` / `SHELL` / `TERM` / `LANG` / `PATH` 这组基础值（再由 `bash -lc` 的 profile 调整），与配置了 `shell.env` 时相比只差注入项

#### Scenario: 两条路径的环境一致

- **WHEN** 同一条命令分别经沙箱与不经沙箱执行
- **THEN** 两条路径 spawn 出的进程环境逐项相同（`HOME` / `SHELL` / `TERM` / `LANG` / `PATH` 及 `shell.env` 注入项），且都由 `bash -lc` 的 profile 调整 `PATH`

#### Scenario: 不继承父进程环境

- **WHEN** pi 进程环境里存在 `SSH_AUTH_SOCK`、`UV_PUBLISH_TOKEN` 等变量，且命令不经沙箱执行
- **THEN** 命令进程中 MUST NOT 出现这些变量，除非它们由 `personalExtensions.shell.env` 显式注入

#### Scenario: 工具版本按工作目录解析

- **WHEN** 工作区的 `mise.toml` pin 了某个工具版本，且命令在沙箱内或沙箱外执行
- **THEN** 两条路径都解析到项目 pin 的版本（`PATH` 由登录 shell 的 profile 重建，而不是沿用父进程的 `PATH`）

#### Scenario: 沙箱内命令拿到注入的变量

- **WHEN** `shell.env` 含 `{ "GIT_EDITOR": "true" }`，且命令在沙箱内执行
- **THEN** 命令进程中 `GIT_EDITOR` 为 `true`（`git commit` / `git rebase -i` 不再拉起真实编辑器）

#### Scenario: 非沙箱路径同样拿到注入的变量

- **WHEN** `shell.env` 含 `{ "GIT_EDITOR": "true" }`，且本次执行不经沙箱（审批通过的全权限，或 fs 与 network 都是 `allow-all`）
- **THEN** 命令进程中 `GIT_EDITOR` 同样为 `true`，且其余环境与沙箱路径一致

#### Scenario: 注入值覆盖基础值

- **WHEN** `shell.env` 里的变量名与基础环境同名（如 `LANG`）
- **THEN** 该变量以 `shell.env` 的值为准，两条路径表现一致

#### Scenario: 预览与执行的环境合并规则一致

- **WHEN** 同一组 env 分别用于预览一条沙箱命令与实际执行该命令
- **THEN** 预览给出的环境与实际 spawn 的环境一致（两者由同一段组装产生）

#### Scenario: 错误语义一致

- **WHEN** 工作目录不存在，或执行前 signal 已 abort
- **THEN** 沙箱路径与本地路径给出相同的错误（目录不存在的提示文本相同；已中断时都不启动进程）

#### Scenario: 其它工具不受影响

- **WHEN** 配置了 `shell.env`
- **THEN** 只有 bash 工具的进程环境变化，LSP 服务器、gh、codemode 脚本等其它工具的子进程环境不变
