# Tasks

## 1. 固定行文案

- [x] 1.1 `src/spawn-agent-progress.ts` 的 `formatUsageStats` 把费用从 `toFixed(4)` 改为 `toFixed(3)`（`$0.0123` → `$0.012`、`$0.5` → `$0.500`），费用为 0 时仍省略该段
- [x] 1.2 `test/spawn-agent-progress.test.ts` 更新 footer 断言为 3 位小数，并补充整数与四舍五入用例（`0.5` → `$0.500`、`0.1236` → `$0.124`、`0.0004` → `$0.000`）
- [x] 1.3 `src/spawn-agent-progress.ts` 删除 `formatUsageStats` 的 turn 分支与 `ProgressUsage.turns`；`src/spawn-agent.ts` 删除 `UsageStats.turns`、初始化与 `message_end` 里的 `turns++`
- [x] 1.4 `test/spawn-agent-progress.test.ts` / `test/spawn-agent.test.ts` 去掉 fixture 与 render 调用里的 `turns`，footer 断言不再含 turn 计数，删除 `result.usage.turns` 的两处断言

## 2. 验证

- [x] 2.1 运行 `pnpm test test/spawn-agent.test.ts test/spawn-agent-progress.test.ts`，断言全部通过
- [x] 2.2 运行 `pnpm check` 与 `pnpm lint`，确认全绿；检查 `git diff` 无无关改动

## Workflow follow-up

- 实现完成后用 openspec-archive-change 归档本 change，并把 delta 同步进 `openspec/specs/spawn-agent/spec.md`。
