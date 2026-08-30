## 1. 配置与基础设施

- [ ] 1.1 `serverConfigSchema` 增加 `kind` 字段（`language` | `linter`，缺省 `language`，非法值按配置错误拒绝），`ConfigAdapter` 透传为 `readonly kind`；`test/lsp-server-config.test.ts` 补 kind 解析与非法值用例（`pnpm test` 通过）
- [ ] 1.2 `resolvePathArg` 从 `src/aft/tools.ts` 移至 `src/lib/path.js`，aft 各工具改为从 lib 导入；`pnpm check` 与 aft 相关测试全绿

## 2. LSP 层 rename 能力

- [ ] 2.1 `src/lib/lsp/client.ts`：`LspClient` 增加 `renameSymbol()`——resolve 路径、`notify.open` 同步磁盘内容、按能力决定是否先发 `prepareRename`（返回 null 抛"位置不可 rename"）、发 `textDocument/rename` 返回 WorkspaceEdit；服务器 MethodNotFound / 无 renameProvider 统一转为可定位错误；`test/lsp-client.test.ts` 补 mock 用例
- [x] 2.2 `src/lib/lsp/lsp.ts`：`LspService` 增加 `rename()`（`kind: "language"` 过滤、多 client 按配置顺序取第一个成功、全部失败抛聚合错误）；既有 lsp 测试不回归

## 3. WorkspaceEdit 应用层

- [x] 3.1 `src/lib/lsp/rename.ts`：`expandWorkspaceEdit(edit, readText)` 纯函数——兼容 `changes` 与 `documentChanges`（仅 TextDocumentEdit），TextEdit 按位置降序应用（UTF-16 偏移、CRLF 安全、越界报错），文件级操作抛"不支持"
- [x] 3.2 行内候选定位：`symbolCandidates`——`character` 缺省时枚举该行与 `symbol` 相同的词出现位置，`character` 给定时校验该列所在词与 `symbol` 一致
- [x] 3.3 `test/lsp-rename.test.ts` 覆盖：changes / documentChanges / 多文件 / 乱序 edit / CRLF / 越界报错 / 文件级操作报不支持 / 候选枚举

## 4. `lsp-rename` 工具（claude-code files.ts）

- [x] 4.1 `src/claude-code/files.ts`：注册 `lsp-rename` 工具（与 Read/Edit/Write 并列，复用闭包内 service 与 reads state；参数校验 → 解析路径 → 读文件 → 按 `symbol` 枚举行内候选 → 逐候选 rename 并比较编辑集合消歧 → `expandWorkspaceEdit` → `guardWriteAccess` + `withFileMutationQueue` 写盘 → 更新 `details.reads` 快照 → 受影响文件诊断）；符号不在行内、歧义、无可 rename 目标均报可定位错误
- [x] 4.2 claude-code `files.ts` 的 `FILE_TOOL_NAMES` 加入 `lsp-rename` 使 `details.reads` 在 resume 后被恢复
- [x] 4.3 vtsls e2e（参照 `test/lsp-e2e-vtsls.test.ts`）：rename 函数断言定义与引用文件同步更新、`symbol` 缺省歧义时报错列候选、补 `character` 后按指定位置执行

## 5. 移除 aft_refactor

- [x] 5.1 删除 `src/aft/refactor.ts`（含 refactor.md）与 `src/aft/imports.ts`（含 import.md），`src/aft/index.ts` 移除注册与相关 import，清理仅写工具使用的辅助代码与测试；`pnpm check` / `pnpm lint` / `pnpm test` 全绿
- [x] 5.2 同步根 `AGENTS.md`：aft 工具清单移除 aft_refactor / aft_import、`pi.extensions` 结构描述、新增 lsp-rename 说明
