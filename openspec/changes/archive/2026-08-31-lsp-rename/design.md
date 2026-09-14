# lsp-rename Design

## Context

`src/lib/lsp/` 已有完整 LSP 客户端层（`client.ts`：连接、didOpen、诊断双通道）与服务层（`lsp.ts`：client 缓存、配置、watcher），但只暴露诊断相关请求；`LspClient.connection`（vscode-jsonrpc `MessageConnection`）可以直接承载 `textDocument/prepareRename` / `textDocument/rename`。`vscode-languageserver-types`（3.18.3）已在依赖里，可复用其类型。

写盘安全面：`guardWriteAccess`（`src/lib/write-guard.ts`）做路径级审批与 change 记账；`withFileMutationQueue` 由 pi 主包提供（`@earendil-works/pi-coding-agent`），claude-code / opencode 两套 files.ts 都在用它串行化写操作。reads 记账（`state.reads`）归各 files.ts 所有。

`registerLsp(pi)` 目前每次调用都 `createLspService`：若新扩展文件再调一次会得到第二套 client 缓存，必须单例化。

## Goals / Non-Goals

**Goals:**

- `LspClient` 增加 rename 请求能力（prepareRename → rename），`LspService` 增加 `rename()` 方法。
- WorkspaceEdit 应用层：纯函数（edit + 文本来源 → 每文件 old/new），先全部计算成功再写盘。
- `lsp-rename` 工具注册为独立扩展，复用写保护、mutation queue、诊断反馈。
- lsp.json `servers[].kind` 字段（`language` | `linter`，缺省 `language`），符号级请求只面向 `language`。
- 移除 `aft_refactor` 与 `aft_import`（工具注册、prompt 文件、测试），aft 收敛为纯只读感知工具集。

**Non-Goals:**

- 不实现 LSP 文件级操作（create/rename/delete document）；遇到直接报不支持。
- 不提供 extract / inline 的替代（随 `aft_refactor` 一并移除）。
- 不做"按符号名定位"（不引入 `symbol` 参数）；定位只靠 file + line + 可选 character。
- 不改两套 files.ts 工具集本身（`lsp-rename` 是独立扩展，不在 claude-code / opencode 里各注册一份）。

## Decisions

### 1. 定位：file + line + symbol 名，工具算列号

模型从 Read / outline 看到的是符号名，让它自己数 1-based 列号既易错也无必要。因此参数为 `file_path` + `line` + `symbol`（该行上的符号名）+ `new_name`，工具在该行按词边界枚举与 `symbol` 相同的出现位置作为候选。保留可选 `character` 仅作逃生口：同行出现同名不同符号时，歧义报错里给出各候选列号，模型补 `character` 重试（工具会校验该列指向的词与 `symbol` 一致）。

### 2. 歧义消解：逐候选发 rename 请求并比较编辑集合

`character` 缺省时，对每个与 `symbol` 相同的词出现位置发 `textDocument/rename`，把返回的 WorkspaceEdit 归一化后（URI 规范化 + JSON 序列化）比较：

- 全部一致 → 同一符号，执行一次写盘；
- 存在不一致 → 报错列出各候选（1-based 行列号 + placeholder），要求补 `character`。

`textDocument/rename` 是纯计算请求，不改变服务器状态，重复请求无副作用；候选只限一行且已按符号名过滤，代价可接受。备选方案"只比较 placeholder"无法区分同类同名符号，放弃。

### 3. WorkspaceEdit 应用：内存全量计算，成功后统一写盘

`expandWorkspaceEdit(edit, readText)` 返回 `{ path, oldText, newText, changeCount }[]`：兼容 `changes` 与 `documentChanges`（仅 TextDocumentEdit），TextEdit 按位置降序（行、列）应用，UTF-16 code unit 语义与 JS 字符串一致；CRLF 文件按原文本直接偏移计算（LSP position 不含行结束符）。任一文件读不到或偏移越界即整体失败。写盘阶段逐文件 `guardWriteAccess` → `withFileMutationQueue` → 写入 → 更新 reads 记账。

替代方案"逐文件边算边写"在多文件重命名中途失败时会留下半成品状态，放弃；写盘阶段的失败（磁盘错误等）接受部分写入，与 Edit / Write 的现有语义一致。

### 4. server 选择：service 层按 adapter kind 过滤

`serverConfigSchema` 增加 `kind`（typebox Union Literal，缺省 `language`），`ConfigAdapter` 透传为 `readonly kind` 字段。`getClients(file, cwd)` 维持现状（诊断仍需要全部服务器），`rename` 路径单独按 `kind === "language"` 过滤。多 client（多个 language 服务器）时按配置顺序取第一个成功结果；一个失败（非"不可 rename"类错误）不影响尝试下一个，全部失败时抛聚合错误。

### 5. 工具放 claude-code files.ts，不引入模块级单例

`lsp-rename` 直接注册在 `registerFileTools` 内，与 Read / Edit / Write 并列：复用同一闭包里的 `service`（`registerLsp(pi)` 的返回值）、`state.reads` 记账、`readStateKey` / `snapshotOf` 与 `withFileMutationQueue`，不需要 `registerLsp` 做模块级单例化，`package.json` 也无需新增扩展条目。代价是 opencode 工具集暂不提供该工具（两套工具集本就允许差异）。

### 6. 定位辅助放 `src/lib/lsp/rename.ts`

候选枚举 / WorkspaceEdit 展开 / 结果归一化是纯函数，与工具层（files.ts）分离；`character` 校验（指定列必须落在与 `symbol` 相同的词内）也在纯函数层完成。`resolvePathArg` 从 `src/aft/tools.ts` 移到 `src/lib/path.js` 供 files.ts 的 lsp-rename 共用（顺带删除其 URL 透传分支——URL 对文件工具不是有效目标）。

### 7. aft_refactor / aft_import 移除

删除 `src/aft/refactor.ts`（含 `refactor.md` prompt）与 `src/aft/imports.ts`（含 `import.md` prompt）、`src/aft/index.ts` 的注册、相关测试。aft 只剩 outline / zoom / callgraph / search 四个只读感知工具；"写工具路径级审批"不再有 aft 侧使用方。

### 8. references 前置：用协议同步点替代"等服务器就绪"

LSP 没有标准化的"项目索引完成"信号（`window/workDoneProgress` 可选且无法可靠关联到索引阶段）。tsserver 系服务器启动后异步加载项目，spawn 完立刻 rename 可能只返回目标文件的编辑。方案：`renameSymbol` 在 rename 前先发 `textDocument/references`（`includeDeclaration: true`）——该请求的响应即同步点（服务器必须完成加载才能回答引用位置）。references 的结果不用于校验 rename 编辑：信任服务器（与编辑器一致），且覆盖校验在部分服务器上存在假阳性（合法地不编辑只读依赖里的引用）会误杀整个 rename。references 返回 MethodNotFound 时跳过（协议兼容性兜底）。

## Risks / Trade-offs

- [多候选探测需要对每候选发完整 rename 请求] → 候选范围限单行、请求是本地进程内的纯计算；最坏情况（一行十几个词全部可 rename）也在毫秒级。
- [写盘阶段部分文件写入成功后失败，留下半完成 rename] → 与 Edit/Write 现有失败语义一致；模型可从工具错误中看到已改文件列表，手工修正。不在本变更内引入事务回滚。
- [LSP position 是 UTF-16 code unit，与某些语言（Python 按 code point）服务器行为存在差异] → JS 字符串本身就是 UTF-16 序列，应用侧按 UTF-16 计算是正确实现；服务器侧差异不在客户端控制范围内。
- [删除 aft_refactor 后 extract / inline 无替代] → 用户已确认接受；aft spec REMOVED 条目记录迁移说明。
- [vtsls/tsserver 对 prepareRename 的支持差异] → 服务器无 prepareProvider 时跳过 prepare 直接 rename，服务器返回的 MethodNotFound / null 统一转成"不可 rename"错误。

## Open Questions

（无）
