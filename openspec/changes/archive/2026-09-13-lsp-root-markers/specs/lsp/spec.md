## MODIFIED Requirements

### Requirement: 服务器启动

服务器 SHALL 按配置启动，包含匹配规则、项目根定位与可执行文件发现。

#### Scenario: 按 include glob 启用

- **WHEN** 文件匹配任一服务器的 `include` glob（相对项目根或调用 cwd）
- **THEN** 该服务器启用（支持 `!` 否定排除）

#### Scenario: 项目根定位

- **WHEN** 服务器未配置 `rootMarkers`
- **THEN** 项目根即调用 cwd；配置了 `workingDir` 时即该目录（相对调用 cwd 解析，绝对路径原样），文件不在该目录内时不启用该服务器
- **WHEN** 配置了 `rootMarkers`（非空字符串数组，元素为精确文件名，目录名亦可）
- **THEN** 从会话 cwd 沿文件路径逐级向下查找，第一个含任一标记的目录即项目根（cwd 自身含标记时即 cwd，取最外层命中）；路径上没有命中时回退会话 cwd；搜索 MUST NOT 越过会话 cwd

#### Scenario: workingDir 与 rootMarkers 互斥

- **WHEN** 同一服务器同时配置了 `workingDir` 与 `rootMarkers`
- **THEN** 视为配置错误并在配置解析时报错，不静默忽略任一字段

#### Scenario: 同一服务器多个项目根

- **WHEN** 同一服务器的文件落在不同项目根（如容器 cwd 下并列的 `~/projects/a` 与 `~/projects/b`）
- **THEN** 每个项目根各自持有一个独立服务器实例；`bin` 解析、`{root}` 模板与项目工作区二进制查找均按该文件的项目根生效；状态与启动失败记录按项目根分别维护
- **WHEN** 重载该服务器
- **THEN** 此前运行中的每个项目根实例都被恢复

#### Scenario: 可执行文件发现

- **WHEN** 配置了 `bin`
- **THEN** 按绝对路径 / 相对调用 cwd / 名字（先在项目内 `node_modules/.bin`、`.venv/bin`、`venv/bin` 找，再走 PATH）解析
