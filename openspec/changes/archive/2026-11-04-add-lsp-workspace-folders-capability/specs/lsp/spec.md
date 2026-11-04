# Spec Delta

## MODIFIED Requirements

### Requirement: 服务器启动

服务器 SHALL 按配置启动，包含匹配规则、项目根定位、可执行文件发现与初始化参数生成。initialize 请求 SHALL 以同一项目根填写 root 相关字段（`rootUri` 与单个 `workspaceFolders` 项），并如实声明已实现的能力位，使声明与实现一致；未实现的能力位 MUST NOT 声明。

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

#### Scenario: 初始化参数由命令生成

- **WHEN** 配置了 `initializationOptionsCommand`
- **THEN** 启动前执行该命令：argv 直接执行（不经 shell），参数项支持 `{root}` / `{cwd}` 模板与 `${VAR}` 插值，cwd 为该服务器的项目根，环境为 process env 叠加已解析的 `env`
- **WHEN** 命令成功退出且 stdout 是 JSON 对象
- **THEN** 该对象与静态 `initializationOptions` 深合并（命令输出优先，嵌套对象逐层递归）作为 initialize 请求的 `initializationOptions`
- **WHEN** 命令非零退出、输出为空、或 stdout 不是 JSON 对象
- **THEN** 该服务器启动失败并报错（错误信息含具体命令、退出码与 stderr），SHALL NOT 启动进程

#### Scenario: 声明 workspace folders 能力

- **WHEN** 客户端向服务器发送 initialize 请求
- **THEN** `capabilities.workspace.workspaceFolders` 为 `true`，且请求携带的 `workspaceFolders` 为单个项目根，与 `rootUri` 指向同一目录
- **WHEN** 服务器据此发出 `workspace/workspaceFolders` 请求
- **THEN** 返回该单个项目根作为工作区文件夹列表
- **WHEN** 服务器实例存活期间项目根未发生切换
- **THEN** 不发送 `workspace/didChangeWorkspaceFolders` 通知

#### Scenario: 能力声明与实现一致

- **WHEN** 客户端发送 initialize 请求
- **THEN** `capabilities.workspace.workspaceEdit.documentChanges`、`capabilities.textDocument.rename.prepareSupport` 为 `true`，`capabilities.textDocument.hover.contentFormat` 含 `markdown` 与 `plaintext`
- **WHEN** rename 返回的 `WorkspaceEdit` 只含 text edit（`changes` 或 `documentChanges` 中的 `TextDocumentEdit`）
- **THEN** 这些 text edit 被应用
- **WHEN** rename 返回的 `WorkspaceEdit` 含文件级操作（创建 / 重命名 / 删除文件）
- **THEN** 明确报不支持，不静默跳过
- **WHEN** initialize 请求声明上述能力位
- **THEN** `capabilities.workspace.workspaceEdit.resourceOperations`、`capabilities.workspace.didChangeWatchedFiles.relativePatternSupport` MUST NOT 出现，`capabilities.workspace.diagnostics.refreshSupport` 为 `false`
