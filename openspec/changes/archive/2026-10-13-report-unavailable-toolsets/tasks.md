# Tasks

## 1. 工厂在不可用时返回提示模块

- [x] 1.1 `createGithubTools()` 在 Windows / `gh` 不在 PATH 时返回只做 `ctx.ui.notify(原因, level)`、不注册工具的模块（措辞与级别沿用原有两条），默认导出不再自己挂提示 handler。验证：`pnpm vitest run test/gh-readonly-setup.test.ts`
- [x] 1.2 `createSpawnAgentTool()` 在 Windows 上同样返回提示模块，默认导出不再自己挂 handler。验证：`pnpm vitest run test/spawn-agent.test.ts`

## 2. 集成验证

- [x] 2.1 全量检查：`pnpm test`（1465 passed / 10 skipped）、`pnpm check`、`pnpm lint` 全绿
- [x] 2.2 入口路径确认：`createGithubTools()` 的返回值一定带 `register`，入口 `addModule` 不再因 `undefined` 静默跳过（由 1.1 的用例经 `session_start` 断言提示覆盖）

## Workflow follow-up

- 归档本变更（把 delta 合入 `openspec/specs/tool-registration/spec.md`）。
