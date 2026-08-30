# lsp-rename Proposal

## Why

仓库的 LSP 集成（`src/lib/lsp/`）目前只覆盖诊断，没有符号级重构能力；模型想改符号名只能靠 `aft_refactor` 的三个 op（move / extract / inline），其中真正常用的 rename（同文件或跨文件改符号名并更新全部引用）反而缺失，且 aft 引擎自身也是走 LSP 实现同类能力。同时 lsp.json 把所有服务器一视同仁，无法区分"真语言服务器"（pyright、clangd、vtsls）与"只实现 LSP 协议的 linter"（ruff），导致符号级功能（rename）无法正确选择目标服务器。

## What Changes

- **新增 `lsp-rename` 工具**（注册在 claude-code `files.ts`，与 Read / Edit / Write 并列）：基于 `textDocument/prepareRename` + `textDocument/rename` 的符号重命名，跨文件更新全部引用。
  - 定位方式：`file_path` + `line`（1-based，必填）+ `symbol`（该行上的符号名，必填）+ `new_name`；另有 `character`（1-based，可选）作同行同名歧义的消歧逃生口。列号由工具计算，模型不数列。
  - `character` 缺省时在该行枚举与 `symbol` 相同的词出现位置逐个探测；全部候选解析到同一编辑集合时直接执行，出现多个不同目标时报错并列出候选，模型补 `character` 重试。
  - 应用层兼容 `changes` 与 `documentChanges`（仅 text edit；create/rename/delete 文件级操作显式报不支持）。
  - 写盘走既有安全面：`guardWriteAccess`（路径级审批 + change 记账）+ per-file mutation queue，写后更新 reads 记账并附带 LSP 诊断。
- **扩展 lsp.json `servers` 配置**：新增 `kind` 字段（`language` | `linter`，缺省 `language`）。`linter` 类（如 ruff）只参与诊断，不参与符号级功能；`lsp-rename` 只会话 `kind: "language"` 的服务器。
- **BREAKING：移除 `aft_refactor` 工具**（`src/aft/refactor.ts`）：`move` 的职责由 `lsp-rename` 承接；`extract` / `inline` 能力随之移除，不提供替代。
- **BREAKING：移除 `aft_import` 工具**（`src/aft/imports.ts`）：aft 收敛为纯只读感知工具集。

## Capabilities

### New Capabilities

- `lsp-rename`: LSP 符号重命名工具——定位（file + line + 可选 character）、同名歧义探测与消歧、WorkspaceEdit 应用与写盘安全、诊断反馈、服务器能力与 `kind` 过滤。

### Modified Capabilities

- `lsp`: `servers` 配置新增 `kind` 字段（`language` | `linter`，缺省 `language`）；`linter` 服务器不参与符号级请求（rename 等），诊断行为不变。
- `aft`: 移除 `aft_refactor` / `aft_import` 及其相关需求（move / extract / inline / import 管理 / 写工具路径级审批）；aft 只剩只读感知工具。

## Impact

- 新增：`src/lib/lsp/client.ts`（rename 请求）、`src/lib/lsp/lsp.ts`（`LspService.rename`）、`src/lib/lsp/rename.ts`（WorkspaceEdit 应用 + 行内候选定位）、`src/claude-code/files.ts`（`lsp-rename` 工具注册）；`resolvePathArg` 从 `src/aft/tools.ts` 移至 `src/lib/path.js` 供 aft 与 `lsp-rename` 共用。
- 不引入模块级单例：`lsp-rename` 与 Read / Edit / Write 共用 `registerFileTools` 闭包内的 service 与 reads state。
- 删除：`src/aft/refactor.ts`、`src/aft/imports.ts`（工具与 prompt 文件）及其在 `src/aft/index.ts` 的注册；相关测试。
- 配置：用户 `~/.pi/agent/lsp.json` 与项目 `.pi/lsp.json` 的 `servers` 增加 `kind` 字段；现有配置无需修改（缺省 `language`）。
- 文档：根 `AGENTS.md` 的 aft 工具清单与 `pi.extensions` 描述需要同步。
