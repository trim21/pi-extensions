# 任务

## 1. 载荷

- [x] 1.1 新增 `src/lib/lsp/inspect-schemas.ts`：位置 schema（1-based `path` / `line` / `character`）、位置载荷 schema（`text` + `serverID` + `locations`）、hover 载荷 schema（`text` + `serverID`）
- [x] 1.2 `src/lib/lsp/inspect-tool.ts`：`InspectOutput` 加泛型载荷，`toLocationPayload` 做 0-based → 1-based 转换（绝对路径原样）
- [x] 1.3 三个工具改 `defineStructuredTool` + `structuredResult`：definition / references 带全部位置，hover 带 `text` + `serverID`；文本、`details`、抛错不变

## 2. 测试

- [x] 2.1 新增 `test/lsp-inspect-structured.test.ts`（fake service + 真实 ToolBus，因此载荷过一遍 schema 复核）：1-based 位置、顺序与文本一致、references 载荷不跟着文本截断（12 条给全）、hover 载荷、无 hover 仍是成功结果
- [x] 2.2 `test/lsp-e2e-inspect.test.ts`（真实 tsserver）补载荷断言：hover 的 `{ text, serverID }`、definition 的 1-based 位置

## 3. 文档与验证

- [x] 3.1 openspec delta：改 `lsp-inspect` 的三条 requirement，写明结构化结果与 1-based 口径
- [x] 3.2 `pnpm check`、`pnpm lint`、`pnpm test`
- [x] 3.3 codemode 侧确认：三个工具因声明了 `structuredSchema` 进入可调用集合，`lsp-rename` 仍在集合外
