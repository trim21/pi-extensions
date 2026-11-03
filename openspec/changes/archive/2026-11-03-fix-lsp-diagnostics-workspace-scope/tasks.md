# Tasks

## 1. 测试 fixture 与回归用例（先失败）

- [x] 1.1 给 `test/fixtures/mock-lsp-server.mjs` 增加 `MOCK_PUSH_EXTRA_URI`（逗号分隔的 file URI）：didOpen 推送诊断时额外为这些 URI 各推一条 ERROR；用一个临时测试或手动启动 fixture 验证 stderr 回显中能看到该推送
- [x] 1.2 在 `test/lsp-server-config.test.ts` 增加回归用例：服务器为工作区外路径推诊断后，`lspDiagnosticsForFile(outsideFile, cwd)` 返回空报告（`text === ""`、计数为 0），`diagnostics()` 聚合里也不含该路径；同服务器拥有的文件仍报告该 ERROR；确认改动前用例失败、改动后通过
- [x] 1.3 在 `test/lsp-server-config.test.ts` 的「include 不匹配」用例补 `lspDiagnosticsForFile` 断言（不属于任何 client 的文件报告为空），「workingDir 限定 root」用例补 `MOCK_PUSH_EXTRA_URI` 构造同路径条目后断言 `lspDiagnosticsForFile` 为空
- [x] 1.4 在「workingDir 限定 root」用例上用 `MOCK_PUSH_EXTRA_URI` 断言 `diagnostics()` 不含 client root 之外的条目（改动前失败），cwd 之外的条目断言放进 1.2
- [x] 1.5 增加祖先 root 回归用例：`workingDir` 指向 cwd 的上级目录，读 cwd 内文件仍正常报告诊断，读 root 内但在 cwd 外的文件报告为空，验证两种情形分别通过

## 2. 实现

- [x] 2.1 抽出 `openAndWaitForDiagnostics(clients, file, mode, options)` 内部 helper，让 `touchFile` 与 `lspDiagnosticsForFile` 共用，验证 `pnpm test test/lsp-config.test.ts test/lsp-server-config.test.ts` 通过
- [x] 2.2 `lspDiagnosticsForFile` 改为只汇总 `getClients` 返回的 client 的诊断，clients 为空时直接返回空报告；验证 1.2、1.3、1.5 的回归用例通过
- [x] 2.3 `LspService.diagnostics()` 聚合按「cwd 内且 client root 内」过滤；验证 1.4 的用例通过，且既有 `test/lsp-server-config.test.ts` 的 `diagnostics()` 断言保持通过

## 3. 验证与文档

- [x] 3.1 运行 `pnpm test`，确认全量测试通过（含 `test/lsp-config.test.ts`、`test/lsp-server-config.test.ts`、`test/lsp-client.test.ts`）
- [x] 3.2 运行 `pnpm check` 与 `pnpm lint`，确认类型检查、Prettier 与 ESLint 全绿
- [x] 3.3 检查最终 diff，确认没有无关改动、调试代码或格式化噪音

## Workflow follow-up

- 按仓库流程用 `openspec-archive-change` 归档本 change，让 spec delta 同步进 `openspec/specs/lsp/spec.md`。
