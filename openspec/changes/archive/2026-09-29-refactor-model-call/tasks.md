# Tasks

> 已完成并实测。实测数字见第 3 节与 design.md D1。

## 1. 新模块

- [x] 1.1 新增 `src/lib/model-call.ts`（90 行）：`ModelRegistryLike`（唯一定义）与 `completeText({ registry, model, systemPrompt, content, maxTokens?, timeoutMs, signal? }) → { text, usage }`；私有 `withTimeout`、user 消息固定带 `timestamp`、空正文抛 `Error("API 未返回内容")`。验证：`tsc --noEmit` 通过。
- [x] 1.2 新增 `test/model-call.test.ts`（225 行，8 个用例）：maxTokens 缺省与覆盖、`Context` 组装（systemPrompt + user content + timestamp）、无 signal 时的真实超时触发、调用方 signal 传导、thinking 不算正文、空正文报错（空数组与只有 thinking 两种）、usage 透传、registry 错误原样上抛（含 `AbortError` 不被改写）。验证：`vitest run test/model-call.test.ts` 8 passed。

## 2. 两个调用点

- [x] 2.1 `src/vision-agent.ts`（+11 / -45，净 **-34**）：删除本地 `ModelRegistryLike`（8 行）与 `withTimeout`（5 行），pi-ai 导入从 8 项收窄到 3 项；`callVision` 的注册表调用改为 `completeText(...)`，`AbortError → VisionAbortError` 的 try/catch 与 token 页脚保留，未传 `maxTokens`（缺省即 `model.maxTokens`）。验证：`tsc --noEmit`、`test/vision-agent.test.ts` 29 passed（无一行断言改动）。
- [x] 2.2 `src/session-name.ts`（+10 / -38，净 **-28**）：同样删除本地 `ModelRegistryLike` 与 `withTimeout`；`callNamer` 改为 `completeText(...)` 并显式传 `maxTokens: NAMER_MAX_TOKENS`（推理模型需要足够输出预算）。验证：`tsc --noEmit`、`test/session-name.test.ts` 34 passed（无一行断言改动）。
- [x] 2.3 两个测试文件的 `ModelRegistryLike` 导入改到 `../src/lib/model-call.js`（各 1 行），其余断言未改。验证：`tsc --noEmit`。

## 3. 验证

- [x] 3.1 聚焦测试：`vitest run test/model-call.test.ts test/vision-agent.test.ts test/session-name.test.ts` = 71 passed。
- [x] 3.2 全量：`pnpm test` = 83 files passed / 1 skipped，1255 passed / 6 skipped（本次净增 8 个用例，全部来自 `test/model-call.test.ts`）。
- [x] 3.3 `pnpm check`（tsc + prettier）与 `pnpm lint` 全绿；改动文件跑过 `prettier --write`。
- [x] 3.4 复核 D1：两个扩展文件各**缩短** 34 / 28 行（调用点变短，不是变长），重复的 `ModelRegistryLike`（8+8 行）与 `withTimeout`（5+5 行）消失；新模块 90 行、模块测试 225 行，仓库净 +253 行。判据判定成立：被隐藏的行为含分支（空正文）、缺省（maxTokens）与错误文案，且调用点确实变短 —— 与被撤回的 `refactor-file-touch-diagnostics`（调用点 5 行 → 9 行）相反。
