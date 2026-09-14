# Proposal: add-lsp-inspect-tools

## Why

`lsp-rename` 已提供写侧的符号级操作，但读侧没有对应能力：改符号前想确认定义在哪、被谁引用、类型签名是什么，目前只能靠 grep + read，对 re-export、跨文件重载、同名遮蔽等场景不可靠。而 LSP 服务器已在运行（诊断 / rename 会拉起），`client.ts` 内部已有 `textDocument/references` 的完整管线（收敛检测 + ContentModified 重试），暴露只读查询的边际成本低。

## What Changes

- 新增三个只读 LSP 工具（claude-code / opencode 工具集共享注册，行为完全一致）：
  - `lsp-find-definition`：`textDocument/definition`，返回符号定义位置列表（`path:line:col` + 行内容片段）。
  - `lsp-find-reference`：`textDocument/references`，按文件分组返回引用位置与行内容片段，带输出截断上限。
  - `lsp-inspect`：`textDocument/hover`，服务器返回的 hover 内容（类型签名 / 文档）原样透传，不做内容归一化。
- 三个工具共用 `lsp-rename` 既有的定位与消歧语义：`file_path` + `line`（1-based）+ `symbol` 定位，`character`（1-based，可选）消歧；列号由工具按词边界枚举候选自行计算。
- `client.ts` 公开 definition / references / hover 三个请求；服务器不支持时抛专门的 NotSupported 错误（对齐 `RenameNotPossibleError` 模式）。
- `LspService` 新增只读查询分发：仅面向 `kind: "language"` 服务器，按配置顺序取第一个成功结果，与 `rename` 同策略。
- 不修改任何现有工具的行为；与 AFT 工具的分工：definition / references / hover 是语言服务器实时语义查询，AFT（outline / search / callgraph）是引擎索引能力，两者互补。

## Capabilities

### New Capabilities

- `lsp-inspect`: 三个只读 LSP 符号查询工具（find-definition / find-reference / inspect-hover）的定位参数、同名歧义消解、多服务器分发、输出格式与截断、能力缺失时的错误行为。

### Modified Capabilities

（无 —— 现有 `lsp` / `lsp-rename` 能力的需求不变；`LspService` 只新增方法，不改变已有行为。）

## Impact

- `src/lib/lsp/client.ts`：新增三个公开请求方法、`InspectLocation` 等类型与 NotSupported 错误类。
- `src/lib/lsp/lsp.ts`：`LspService` 接口新增 `inspect` 分发方法。
- `src/lib/lsp/inspect-tool.ts`（新增）：共享工具壳，注册三个工具。
- `src/claude-code/files.ts`、`src/opencode/files.ts`：各增加一行注册。
- `src/spawn-agent.ts`：注释说明 opencode/files.ts 额外注册的共享工具（与 lsp-rename 同模式）。
- 测试：`test/fixtures/mock-lsp-server.mjs` 扩展 definition / references / hover 响应；client 单测与 vtsls e2e。
