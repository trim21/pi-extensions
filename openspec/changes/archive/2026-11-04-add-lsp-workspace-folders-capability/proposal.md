# Proposal

## Why

LSP 客户端已经在 initialize 请求里发送 `workspaceFolders`（单个项目根），也已经应答服务器的 `workspace/workspaceFolders` 请求，但 `capabilities.workspace` 里没有声明 `workspaceFolders: true`。按规范，`InitializeParams.workspaceFolders`「只有客户端声明支持 workspace folders 时才可用」，所以现在的实现是「能力上支持、声明上不承认」：按能力判断的服务器会忽略我们已经发出的工作区信息，退回去依赖已被标记废弃的 `rootUri`。

## What Changes

- `initialize` 请求的 `capabilities` 补齐三个已经开始使用、但没声明支持的能力位：
  - `workspace.workspaceFolders: true` —— 与既有的「发送 `workspaceFolders` 参数 + 应答 `workspace/workspaceFolders` 请求」对齐。
  - `workspace.workspaceEdit.documentChanges: true` —— rename 返回的 `documentChanges` 里的 text edit 本来就会被应用。
  - `textDocument.rename.prepareSupport: true` —— 本来就会发 `textDocument/prepareRename` 并使用返回的 `placeholder`。
  - `textDocument.hover.contentFormat: ["markdown", "plaintext"]` —— 本来两种 MarkupKind 都会渲染。
- 明确不声明对应实现缺失的能力位（`workspaceEdit.resourceOperations`、`didChangeWatchedFiles.relativePatternSupport`、`diagnostics.refreshSupport: true` 等），避免虚假承诺。
- root 的来源与取值不变：仍同时发送 `rootUri`（协议里它是必填字段，且 `typescript-language-server` 只读它），`workspaceFolders` 仍为单个项目根。
- 仍不发送 `workspace/didChangeWorkspaceFolders`：会话内不切换工作区，文件夹集合在服务器实例生命周期内固定。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `lsp`: 「服务器启动」要求补充 initialize 能力声明 —— 客户端 SHALL 如实声明已经实现的能力位（workspace folders、`documentChanges`、`prepareRename`、hover 内容格式），且 MUST NOT 声明尚未实现的能力位。

## Impact

- 代码：`src/lib/lsp/client.ts` 的 initialize 参数构造。
- 服务器行为：声明后服务器可能发 `workspace/workspaceFolders` 请求（已被应答）并订阅 `workspace/didChangeWorkspaceFolders`（不会产生通知，无副作用）。`typescript-language-server` 只读 `rootUri`，行为不变；`pyright` 按参数是否存在解析 root，行为不变。
- 不受影响：项目根定位、`workspaceFolders` 取值、`rootUri` 保留策略、诊断与文件事件同步流程。
