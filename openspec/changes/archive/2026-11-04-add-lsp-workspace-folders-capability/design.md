# Design

## Context

initialize 参数在 `src/lib/lsp/client.ts` 的一个对象字面量里构造：`rootUri` 与 `workspaceFolders` 都填同一个项目根，`capabilities.window` / `capabilities.workspace` / `capabilities.textDocument` 分别声明进度、配置、文件监听、拉取诊断等能力，`capabilities.workspace` 目前只有 `configuration` / `didChangeWatchedFiles` / `diagnostics`。同一连接上已经应答 `workspace/workspaceFolders` 请求（返回单个项目根）。动机见 proposal.md。

涉及的服务器实现（本机安装版本核对）：`typescript-language-server` 的 `initialize()` 只读 `params.rootUri`，回退 `params.rootPath`，不读 `params.workspaceFolders`；`pyright` 的 `WorkspaceFactory.handleInitialize` 按 `params.workspaceFolders` 是否存在决定 root，存在则用、否则用 `rootPath`，不读 `rootUri`。

## Goals / Non-Goals

**Goals:**

- 让 initialize 的能力声明与既有的 workspace folders 实现（发送参数 + 应答请求）自洽。
- 不改变任何服务器的项目根取值。

**Non-Goals:**

- 不引入多根工作区、不实现 `workspace/didChangeWorkspaceFolders`。
- 不改造按项目根分实例的既有生命周期逻辑。

## Decisions

- **声明 `workspaceFolders: true`，不声明 `changeNotifications`**：`changeNotifications` 表示客户端会发 `workspace/didChangeWorkspaceFolders` 通知；本项目每个项目根固定一个服务器实例，会话内不切换文件夹，声明它反而是虚假承诺。只声明支持后，服务器可能订阅该通知，但收不到任何消息，无副作用。
- **保留 `rootUri`，不接受「声明能力后删掉废弃字段」**：`rootUri` 在 `vscode-languageserver-protocol` 里仍是必填字段（`DocumentUri | null`），且 `typescript-language-server` 只从它取 root；删掉需要绕过类型系统并会让该服务器失去工作目录。因此 `no-deprecated` 的行内抑制保留。
- **能力对所有服务器统一声明，不按服务器配置开关**：这是客户端侧能力的如实声明，与具体服务器无关；按服务器开关会引入无收益的配置维度。
- **`workspaceFolders` 取值保持不变（单个项目根）**：能力声明只影响服务器是否采信该参数，不改变参数内容，因此多根场景仍由「每个项目根一个实例」承担。
- **另外三个能力位一并声明（`workspaceEdit.documentChanges`、`rename.prepareSupport`、`hover.contentFormat`）**：这三项的实现都已经存在（rename 会应用 `documentChanges` 里的 text edit、会发 `textDocument/prepareRename` 并读 `placeholder`、hover 两种 MarkupKind 都渲染），缺的只是声明。核对 `typescript-language-server` 与 `pyright` 的实现后确认二者都不按这些位分支（前者的 `initialize` 只读 `rootUri`/`rootPath`，后者按 `params.workspaceFolders` 是否存在决定 root），因此声明它们不改变任何服务器行为。
- **不声明实现缺失的能力位**：`workspaceEdit.resourceOperations`（rename 明确拒绝文件级操作）、`didChangeWatchedFiles.relativePatternSupport`（非字符串 glob 被丢弃）、`diagnostics.refreshSupport: true`（`workspace/diagnostic/refresh` 处理器是空操作）、`publishDiagnostics.{tagSupport,codeDescriptionSupport,dataSupport,relatedInformation}`（诊断只渲染 severity + 位置 + message）、`diagnostic.markupMessageSupport`（只在收到时防御性处理）、`textDocument.synchronization.dynamicRegistration`（只处理 watchers 与 diagnostic 两类动态注册）。声明这些会让服务器走我们并未实现的路径，属于虚假承诺。
- **`general.positionEncodings` 保持省略**：省略即默认 `utf-16`，与我们的位置计算一致，显式声明没有收益。

## Risks / Trade-offs

- [声明后服务器开始走 workspace folders 路径，而某服务器对该路径的处理比 rootUri 路径更严格] → 只声明支持、声明前后参数内容不变；已核对的两种主流服务器（tsls 只认 rootUri、pyright 按参数存在性判断）行为均不变，其余服务器仍收到同值的 `rootUri` 与单元素 `workspaceFolders`，最坏情况与原行为等价。
- [未来若把 root 改成多根，`changeNotifications` 的缺失会让服务器收不到变更通知] → 那时需要同时实现通知发送并补上 `changeNotifications`，属于新的行为变更。
