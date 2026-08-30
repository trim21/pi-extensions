## MODIFIED Requirements

### Requirement: 服务器配置

LSP 服务器 SHALL 全部由 JSON 配置声明，项目配置优先于全局，按服务器 id 合并；不存在内置默认服务器集合。每个服务器可声明 `kind`（`language` | `linter`，缺省 `language`）。

#### Scenario: 项目覆盖全局

- **WHEN** 项目 `.pi/lsp.json` 与全局 `~/.pi/agent/lsp.json` 都存在
- **THEN** 顶层字段本地覆盖全局；`servers` 按 id 合并（同名整体覆盖、新 id 新增、全局其余保留）

#### Scenario: 无内置默认服务器

- **WHEN** 全局与本地配置都没有定义 `servers`
- **THEN** 不启动任何语言服务器；写文件后诊断集合为空，不报错也不提示配置缺失

#### Scenario: 用顶层列表启用或禁用服务器

- **WHEN** 需要排除某个已在配置中定义的服务器
- **THEN** 用顶层 `disabled: [id]`（未注册的 id 直接忽略）；顶层 `enabled: [id, ...]` 为白名单，引用未注册的 id 视为配置错误并在加载时提示

#### Scenario: 声明服务器类型

- **WHEN** `servers` 中某服务器配置了 `kind`
- **THEN** 仅接受 `language`（真语言服务器，如 pyright / clangd / vtsls）或 `linter`（只实现 LSP 协议的 lint，如 ruff）；缺省为 `language`；其他值按配置错误拒绝

## ADDED Requirements

### Requirement: 符号级请求按服务器类型过滤

符号级功能（rename 等）SHALL 只会话 `kind: "language"` 的服务器；`linter` 类服务器只参与诊断。

#### Scenario: linter 不参与符号级功能

- **WHEN** 文件同时匹配 `language` 与 `linter` 类服务器，模型调用符号级工具
- **THEN** 只使用 `language` 类服务器；`linter` 类服务器不因此被 spawn

#### Scenario: 诊断不受影响

- **WHEN** 服务器配置为 `kind: "linter"`
- **THEN** 其诊断行为（写文件后等待与报告）与 `language` 类服务器完全一致
