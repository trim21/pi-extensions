# Tasks

## 1. 声明已实现的能力

- [x] 1.1 在 `src/lib/lsp/client.ts` 的 initialize 参数里，给 `capabilities.workspace` 增加 `workspaceFolders: true`（不声明 `changeNotifications`）与 `workspaceEdit.documentChanges: true`；验证：`pnpm run check` 通过，且该对象中 `rootUri` 与 `workspaceFolders[0].uri` 仍为同一项目根
- [x] 1.2 给 `capabilities.textDocument` 增加 `rename.prepareSupport: true` 与 `hover.contentFormat: ["markdown", "plaintext"]`；验证：`pnpm run check` 通过，且未新增 `resourceOperations` / `relativePatternSupport` / `refreshSupport: true` 等未实现的能力位

## 2. 回归测试

- [x] 2.1 在 `test/lsp-client.test.ts` 增加用例：以 `MOCK_ECHO_REQUESTS=1` 启动 mock 服务器（见 `test/fixtures/mock-lsp-server.mjs`，请求会以 JSONL 回显到 stderr），抓取 initialize 请求，断言 `capabilities.workspace.workspaceFolders === true`、`workspace.workspaceEdit.documentChanges === true`、`workspace.diagnostics.refreshSupport === false`、`textDocument.rename.prepareSupport === true`、`textDocument.hover.contentFormat` 为 `["markdown", "plaintext"]`，且 `rootUri` 与 `workspaceFolders[0].uri` 为同一项目根 URI；验证：先在未改 `client.ts` 时确认该断言失败，改后 `pnpm vitest run test/lsp-client.test.ts` 通过

## 3. 全量验证

- [x] 3.1 运行 `pnpm run lint`、`pnpm run check`、`pnpm test`，全部通过
- [x] 3.2 运行依赖真实 `typescript-language-server` 的用例（`pnpm vitest run test/lsp-e2e-tsls.test.ts`）确认项目根定位与诊断流程未受影响

## Workflow follow-up

- 实现完成并验证通过后，用 `openspec-archive-change` 归档本 change，把 delta 合入 `openspec/specs/lsp/spec.md`
