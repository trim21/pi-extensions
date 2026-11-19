# Tasks

## 1. settingsPath 注入缝

- [x] 1.1 `ClaudeCodeFileToolOptions` / `OpencodeFileToolOptions` 增加 `settingsPath?: string`（注释说明供注入固定 settings 来源），两个默认导出改为 `createToolRegistration(pi, options?.settingsPath)`；验证：`pnpm check` + 既有 `test/tool-registration-entry.test.ts` 不回归

## 2. 测试显式传参

- [x] 2.1 `test/lsp-e2e-rename.test.ts`、`test/lsp-e2e-inspect.test.ts`、`test/lsp-e2e-tsls.test.ts`、`test/lsp-e2e-gopls.test.ts`、`test/lsp-e2e-pyright-ruff.test.ts`、`test/opencode-read.test.ts` 在调用点显式传 `settingsPath`（指向必然不存在的临时路径）与 `globalConfigPath`（同样必然不存在），不设置任何环境变量；验证：在本机真实用户配置（`fileIoReadTracking: false`）存在的情况下跑这 6 个文件全绿，`lsp-e2e-rename` 的 `details.reads` 断言转绿

## 3. 整体验证

- [x] 3.1 `pnpm lint`、`pnpm check`、`pnpm test` 全绿（本机用户配置存在的情况下，`lsp-e2e-rename` 不再受 `fileIoReadTracking: false` 影响）；确认 diff 只含本 change 所列改动（无占位、无无关格式化）

## Workflow follow-up

- 实现完成后按 openspec-archive-change 流程归档本 change
- 交付方式沿用「开一个新 PR」：从 master 拉实现分支，PR 关联本 change；与 `unify-agent-dir-config-paths` 无实现依赖，可各自独立 PR / apply / 归档
