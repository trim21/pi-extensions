# Tasks

## 1. 校验 module（`src/lib/lsp/rename.ts`）

- [x] 1.1 把 `RenameIncompleteError` 从 `src/lib/lsp/client.ts:115` 移到 `rename.ts`（类名、构造函数签名、`missing` / `extra` 字段、消息格式逐字不变）；`client.ts` 改为从 `./rename.js` 引入并**不再导出**它；验证：`node_modules/.bin/tsc --noEmit` 通过（此时 `test/lsp-client.test.ts` 的 import 仍指向 `client.js`，报错属预期，下一组任务修）。
- [x] 1.2 新增 `RenameVerificationTiming` 类型与 `DEFAULT_RENAME_VERIFICATION_TIMING`（数值取自现 `client.ts:148-164`：`pollMs: 400`、`budgetMs: 15_000`、`contentModifiedRetries: 3`、`settleSamples: 3`、`stableFloorReadyMs: 400`、`stableFloorUnreadyMs: 4_000`，字段级注释一并保留）；验证：`node_modules/.bin/tsc --noEmit`。
- [x] 1.3 实现 `verifyRenameCoverage(options)`，签名与判定顺序见 design.md D1 / D4：先 `signal.throwIfAborted()` → `stabilityAcceptable` → `expired` → `sendRename()`（null 抛 `notRenameable()`）→ 双向 missing / extra 比对 → 四种归宿（稳定且一致返回 edit；一致但未稳定抛 `RenameIncompleteError([], [])`；`expired` 或有 missing 抛 `RenameIncompleteError(missing, extra)`；只有 extra 则 `sleep(pollMs, signal)` 后 `refetchPaths()` 推进 `trackStability` 再来一轮）；三层策略的说明注释（现 `client.ts:1477-1492`）移到该函数的文档注释；验证：`node_modules/.bin/vitest run test/lsp-rename.test.ts` 通过（新用例见 3.1）。

## 2. 调用侧（`src/lib/lsp/client.ts`）

- [x] 2.1 删除 `export const renameVerificationTiming`；`CreateInput` 新增 `renameVerificationTiming?: Partial<RenameVerificationTiming>`，client 内解析成 `{ ...DEFAULT_RENAME_VERIFICATION_TIMING, ...input.renameVerificationTiming }` 并持有；`retryOnContentModified` 改为接收重试上限参数（三个调用点传该 client 的 `contentModifiedRetries`）；验证：`node_modules/.bin/tsc --noEmit`，且 `grep -n "renameVerificationTiming" src/lib/lsp/client.ts` 只剩创建参数解析那一处（不再有 module 级定义或跨函数直读）。
- [x] 2.2 `renameSymbol` 里 `client.ts:1575-1631` 的内联编排替换为一次 `verifyRenameCoverage({ indexReady, timing, initialPaths: toPaths(locations), refetchPaths: async () => toPaths(await referencesRequest()), sendRename: async () => (await sendRename()) ?? null, sleep: sleepWithSignal, now: () => Date.now(), notRenameable, signal: request.signal })`，返回值直接与 placeholder 组装；`MethodNotFound` 跳过校验的既有分支、prepare 分支、references 前置请求都保持不变；验证：`node_modules/.bin/vitest run test/lsp-client.test.ts` 通过（用例名与断言不变）。

## 3. 测试

- [x] 3.1 `test/lsp-rename.test.ts` 新增 `verifyRenameCoverage` 的直接用例（假 `now` / `sleep` / `initialPaths` / `refetchPaths` / `sendRename`）：收敛后成功返回 edit；只有 extra 时继续轮询、收敛后成功；预算耗尽且 missing → `RenameIncompleteError(missing, extra)`；双向一致但未达稳定窗口 → `RenameIncompleteError([], [])`（`missing` / `extra` 均为空数组）；`sendRename` 返回 null → 抛 `notRenameable()` 产出的错误；验证：`node_modules/.bin/vitest run test/lsp-rename.test.ts` 通过，并做一次变异取证——把 `throw new RenameIncompleteError([], [])` 改成 `return edit` 时该用例失败，随后还原。（原配方「改成抛 missing/extra 版本」不可观测：该分支只在 missing/extra 均为空时可达，两种构造等价。）
- [x] 3.2 `test/lsp-client.test.ts`：import 的 `RenameIncompleteError` 改自 `rename.js`；删掉 `:585` 的「保持串行」注释与各处 `savedTiming` 保存 / 恢复块，改为在 `create({...})` 时传 `renameVerificationTiming`（原改写的数值逐项对应搬过去）；**用例名与断言不得改动**；验证：`node_modules/.bin/vitest run test/lsp-client.test.ts` 通过，且 `git diff test/lsp-client.test.ts` 中每个改动都只涉及 timing 注入或 import。

## 4. 验证与收尾

- [x] 4.1 `node_modules/.bin/prettier --write src/lib/lsp/rename.ts src/lib/lsp/client.ts test/lsp-rename.test.ts test/lsp-client.test.ts`；验证：随后 `git diff --stat` 只有预期的四个文件。
- [x] 4.2 报告 `renameSymbol` 内联块重构前后的行数与 `grep -c "renameVerificationTiming" src/lib/lsp/client.ts` 的变化。
