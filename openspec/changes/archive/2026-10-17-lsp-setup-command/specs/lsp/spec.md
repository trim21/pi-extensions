# Spec Delta

## ADDED Requirements

### Requirement: 服务器 setup 命令

服务器配置可声明 `setup` 命令（argv 数组）在启动服务器实例前准备执行环境（如补装可执行文件）。每次启动该服务器实例（含 reload 后重启）时 SHALL 在解析 `bin` 之前无条件执行，无论 binary 是否解析得到；执行完成后解析 `bin` 并继续启动流程。未配置 `setup` 时启动行为不变。

#### Scenario: 每次启动前无条件执行

- **WHEN** 服务器配置了 `setup` 且即将启动服务器实例
- **THEN** 执行 setup 命令：argv 直接执行（不经 shell），参数项支持 `{root}` / `{cwd}` 模板与 `${VAR}` 插值，cwd 为该服务器的项目根，环境为 process env 叠加已解析的 `env`；stdout 被忽略，允许为空
- **WHEN** setup 成功退出
- **THEN** 解析 `bin` 并用解析到的可执行文件继续启动（setup 新安装的可执行文件应当能被发现）

#### Scenario: binary 存在时也执行

- **WHEN** `bin` 能解析到可执行文件
- **THEN** setup 仍照常执行，执行完成后再启动该可执行文件

#### Scenario: setup 失败即启动失败

- **WHEN** setup 命令 spawn 失败或非零退出
- **THEN** 该服务器启动失败并报错（错误信息含具体命令、退出码与 stderr），SHALL NOT 启动进程，无论 binary 是否解析得到

#### Scenario: setup 后仍解析不到可执行文件

- **WHEN** setup 成功退出但 `bin` 解析仍失败
- **THEN** 该服务器启动失败并报错，错误信息说明 setup 已执行但可执行文件仍不可用
