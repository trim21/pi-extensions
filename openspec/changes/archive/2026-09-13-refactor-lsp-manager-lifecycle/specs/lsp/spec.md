# lsp 规格变更

## ADDED Requirements

### Requirement: LSP 工具条件注册

LSP 专属工具（`lsp-rename`、`lsp-find-definition`、`lsp-find-reference`、`lsp-inspect`）SHALL 仅在当前会话存在 enabled 的 LSP 服务器时注册并对模型可见；read / edit / write 等文件工具 SHALL 无条件注册，不受 LSP 配置影响。

#### Scenario: 未配置 lsp.json

- **WHEN** 会话 cwd 及全局均无 `lsp.json` 或 `servers` 为空
- **THEN** LSP 专属工具不出现在模型工具列表中；文件工具正常注册

#### Scenario: 配置有效

- **WHEN** `lsp.json` 定义了至少一个 enabled 服务器
- **THEN** LSP 专属工具在首轮对话前注册完成并对模型可见

#### Scenario: 子代理工具白名单

- **WHEN** 子代理通过工具白名单声明 LSP 专属工具
- **THEN** 白名单过滤发生在注册之后的每次工具表重建，迟到注册的白名单内工具正常激活

### Requirement: 惰性生命周期

LSP 配置 SHALL 在 `session_start` 时加载并校验（pi await 该事件）；配置有效时才创建 service 实例，服务器进程仍保持首次工具调用时惰性 spawn。扩展实例随会话重建（reload / new / resume / fork）时，manager 与其闭包状态 SHALL 一并重建，旧实例的进程由 `session_shutdown` 清理。

#### Scenario: 配置错误降级

- **WHEN** `lsp.json` 存在但解析或校验失败
- **THEN** 向用户提示错误，LSP 保持 disabled，文件工具照常工作，不阻断会话启动

#### Scenario: 会话切换无泄漏

- **WHEN** 用户执行 /new、/resume 或 /fork
- **THEN** 旧实例在 session_shutdown 时关闭全部服务器进程；新会话的 manager 从零构建

### Requirement: service 不可用时的降级

文件工具对 LSP service 的访问 SHALL 通过惰性访问器完成；service 未创建或 disabled 时，访问器 SHALL 返回共享的 no-op service（诊断与文件事件通知为空操作），SHALL NOT 抛错或反复重建。

#### Scenario: 未配置时的写后诊断

- **WHEN** LSP disabled 时调用 edit / write
- **THEN** 工具正常完成写入，诊断输出为空，行为与"无匹配服务器"时一致

#### Scenario: 管理命令在 disabled 状态

- **WHEN** LSP disabled 时调用 /lsp-stop、/lsp-start 或 /lsp-reload
- **THEN** 命令给出"LSP 未配置"类的友好提示，不报错不 spawn 进程
