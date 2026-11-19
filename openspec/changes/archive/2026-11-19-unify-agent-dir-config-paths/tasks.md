# Tasks

## 1. 路径解析统一

- [x] 1.1 `src/lib/lsp/lsp.ts` 两处全局 `lsp.json` 默认路径改 `join(getAgentDir(), "lsp.json")`（`loadLspConfig` 默认参数与 `createLspService` 回退），补 `getAgentDir` 导入；验证：`pnpm check` + `pnpm exec vitest run test/lsp-e2e-rename.test.ts test/lsp-e2e-tsls.test.ts`（显式传 `globalConfigPath` 的既有测试不受影响）
- [x] 1.2 `src/session-name.ts`、`src/vision-agent.ts` 的 `SETTINGS_PATH` 改 `join(getAgentDir(), "settings.json")`；验证：`pnpm exec vitest run test/session-name.test.ts test/vision-agent.test.ts`（如有）+ `pnpm check`
- [x] 1.3 `src/lib/proxy.ts` 的 `proxyConfigPath()`、`src/openai-cost/config.ts` 的配置路径改 `getAgentDir()`；验证：`pnpm check` + `pnpm exec vitest run test/web-fetch.test.ts test/openai-cost*.test.ts`（如有对应测试）

## 2. 整体验证

- [x] 2.1 `pnpm lint`、`pnpm check` 全绿；`pnpm test` 除「本机用户配置导致的 `lsp-e2e-rename` 已知失败」（由 `test-config-injection` 解决，CI 上本就全绿）外全绿；确认 diff 只含本 change 所列改动（无占位、无无关格式化）

## Workflow follow-up

- 实现完成后按 openspec-archive-change 流程归档本 change（含 `lsp` spec delta 同步到 `openspec/specs/lsp/spec.md`）
- 交付方式沿用「开一个新 PR」：从 master 拉实现分支，PR 关联本 change
