# Tasks

## 1. 抽出轮询核心

- [x] 1.1 `src/lib/lsp/client.ts`：在 `waitForDocumentDiagnostics` 之前新增闭包内 `PollOutcome` 类型与 `pollUntilSettled(params)` 函数声明，实现三路竞速（`pushWait` / `waitForRegistrationChange(remaining)` / `sleep(min(remaining, PULL_RETRY_INTERVAL_MS))`）、剩余预算、`connectionClosed` 与 `signal.aborted` 判定、`pullTimedOut` 与 `budgetExhausted` 两个出口；验证：`node_modules/.bin/tsc --noEmit` 通过。
- [x] 1.2 `waitForDocumentDiagnostics` 缩成适配层：保留「已有不早于最后一次内容同步的 push 结论就直接返回 true」的前置短路、silent 短预算计算、按预算创建 `pushWait`，然后调用核心并把四态映射回 `boolean`（`pulled`/`pushed` → true，`pullTimedOut` → `await pushWait`，`budgetExhausted` → false）；验证：`node_modules/.bin/vitest run test/lsp-client.test.ts test/lsp-pull-timeout.test.ts` 通过。
- [x] 1.3 `waitForFullDiagnostics` 同样缩成适配层：预算 `diagnosticsFullWaitTimeoutMs`、就绪判据 `result.handled || result.matched`、`pullTimedOut → await pushWait` 后返回（结果丢弃）；验证：`node_modules/.bin/vitest run test/lsp-client.test.ts test/lsp-pull-timeout.test.ts` 通过，且 `grep -c "Promise.race" src/lib/lsp/client.ts` 从 4 降到 3（另外两处 `client.ts:462` / `1332` 属于连接关闭竞速，不动），三路竞速只剩轮询核心一处。
- [x] 1.4 两处结果映射各加一行注释，指明它对应重构前的哪条返回路径（document 的 `pullTimedOut → await pushWait` 是重点）；验证：读改动后的两个函数，能在三行内说清「两种模式的差异是什么」。

## 2. 覆盖确认

- [x] 2.1 确认 full 模式（`mode: "full"`）在既有用例中的覆盖情况：`grep -rn "mode: \"full\"" test/`；若除 `test/lsp-commands.test.ts` 之类只断言端到端的用例之外没有直接覆盖，按 design D5 补一条最小用例（mock 服务器不响应 pull → 等待在预算内结束并转入 push 兜底），或在该任务里明确记录「无直接覆盖」；验证：`node_modules/.bin/vitest run test/lsp-client.test.ts test/lsp-pull-timeout.test.ts` 通过。
- [x] 2.2 `test/lsp-client.test.ts` 与 `test/lsp-pull-timeout.test.ts` 的断言不得修改（只允许 import / 类型层面的必要调整）；验证：`git diff test/lsp-client.test.ts test/lsp-pull-timeout.test.ts` 无非 import / 非类型改动，若有则说明行为发生了变化并停下报告。

## 3. 验证

- [x] 3.1 `node_modules/.bin/prettier --write src/lib/lsp/client.ts`；验证：`git diff src/lib/lsp/client.ts` 只有预期改动。
- [x] 3.2 报告重构前后两个函数的行数变化，以及 `pnpm exec vitest run test/lsp-*.test.ts`（由我执行）所需的聚焦范围。
