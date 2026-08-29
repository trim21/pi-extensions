# lsp Specification

## Purpose

read / edit / write 工具内置 LSP 诊断：写文件后等待并报告 ERROR 级诊断。LSP 服务器通过一份 JSON 配置声明如何启动，无需为每种语言写 adapter。

## Requirements

### Requirement: 服务器配置

LSP 服务器由 JSON 配置声明，项目配置优先于全局，按服务器 id 合并。

#### Scenario: 项目覆盖全局

- **WHEN** 项目 `.pi/lsp.json` 与全局 `~/.pi/agent/lsp.json` 都存在
- **THEN** 顶层字段本地覆盖全局；`servers` 按 id 合并（同名整体覆盖、新 id 新增、全局其余保留）

#### Scenario: 内置默认服务器始终存在

- **WHEN** 未显式配置
- **THEN** 内置默认服务器（typescript / pyright / ruff / clangd）可用；配置可整体覆盖或 `"enabled": false` 移除

### Requirement: 服务器启动

服务器按配置启动，包含匹配规则、项目根定位与可执行文件发现。

#### Scenario: 按 include glob 启用

- **WHEN** 文件匹配任一服务器的 `include` glob（相对项目根或调用 cwd）
- **THEN** 该服务器启用（支持 `!` 否定排除）

#### Scenario: 项目根定位

- **WHEN** 配置了 `rootMarkers`
- **THEN** 从文件目录向上查找标记文件作为项目根；缺省用调用 cwd

#### Scenario: 可执行文件发现

- **WHEN** 配置了 `bin`
- **THEN** 按绝对路径 / 相对调用 cwd / 名字（先在项目内 `node_modules/.bin`、`.venv/bin`、`venv/bin` 找，再走 PATH）解析

### Requirement: 写后诊断

写文件后等待服务器诊断，报告 ERROR 级诊断。

#### Scenario: 写后报告诊断

- **WHEN** 写工具写入文件
- **THEN** 等待（`diagnosticsWaitMs`）并报告 ERROR 级诊断

#### Scenario: 超时与配置分离

- **WHEN** 配置 `startupTimeoutMs` / `diagnosticsWaitMs` / `initializeTimeoutMs`
- **THEN** 覆盖全局与默认值；`initializationOptions` 进 initialize 请求、`settings` 进 didChangeConfiguration / workspace/configuration 请求

## Implementation

实现位于 `src/lib/lsp/`：read / edit / write 工具写文件后经 LSP 客户端请求诊断并报告 ERROR 级诊断。

- **配置解析**（`server-config.ts`）：`~/.pi/agent/lsp.json`（全局）与 `.pi/lsp.json`（项目）合并——顶层字段本地覆盖全局，`servers` 按 id 合并（同名整体覆盖、新 id 新增、全局其余保留）；内置默认服务器（typescript / pyright / ruff / clangd）始终存在，`"enabled": false` 移除。
- **服务器启动**（`adapter.ts`）：按 `include` glob 匹配启用（`!` 否定排除），`rootMarkers` 向上定位项目根（缺省调用 cwd），`bin` 按绝对路径 / 相对调用 cwd / 名字（先项目内 `node_modules/.bin`、`.venv/bin`、`venv/bin`，再 PATH）解析；`cwd` 支持 `{root}` / `{cwd}` 模板。
- **协议**：`initializationOptions` 进 initialize 请求，`settings` 进 didChangeConfiguration / workspace/configuration；languageId 按扩展名映射（缺省内置映射表）。
- **超时**：per-server `startupTimeoutMs` / `diagnosticsWaitMs` 覆盖全局与默认值。

涉及文件：`src/lib/lsp/`（lsp.ts / server-config.ts / adapter.ts / client.ts）。
