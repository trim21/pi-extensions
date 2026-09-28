# Proposal

## Why

rename 的覆盖校验（「等 references 收敛再信它」）目前分居三处，而真正的判定埋在一段 60 行的内联循环里：

- 纯函数在 `src/lib/lsp/rename.ts`（`trackStability:226`、`stabilityAcceptable:239`、`editFilePaths:169`），各有单测，但真正的调用者只有 `client.ts` 里那段内联编排；
- 策略常量是 `src/lib/lsp/client.ts:148` 的 **module 级可变导出** `renameVerificationTiming`（`pollMs` / `budgetMs` / `settleSamples` / 两个稳定窗口下限 / ContentModified 重试上限），没有任何创建参数可以覆盖它；
- 就绪栅栏、稳定窗口推进、missing/extra 双向校验与 `RenameIncompleteError` 判定全都写在 `renameSymbol` 的循环里（`client.ts:1575-1631`）。

代价有两面。一是 locality：理解「rename 为什么必须等、什么时候能信任 references」要在常量、纯函数、内联循环之间来回跳，而最近两次相关 bugfix（`4d5c912`、`ebc95fe`）都落在这段内联编排上。二是测试：因为策略常量是共享可变对象，`test/lsp-client.test.ts` 只能临时改写再恢复，并在 `:585` 明确注释「该组保持串行」——并发会互相覆盖，把改后的预算泄漏给组内其他用例。

## What Changes

- `src/lib/lsp/rename.ts` 新增 `verifyRenameCoverage(options)`：收敛等待（就绪栅栏 → 稳定窗口）与双向覆盖校验（missing / extra）的唯一实现，依赖全部注入——`now` / `sleep` / `initialPaths` / `refetchPaths` / `sendRename` / `notRenameable` / `timing` / `indexReady` / `signal`，因此收敛序列与预算可以直接喂进去验证。
- `RenameVerificationTiming` 类型与 `DEFAULT_RENAME_VERIFICATION_TIMING` 移入 `rename.ts`；`client.ts` 的 module 级可变导出 `renameVerificationTiming` 删除，改为 `CreateInput.renameVerificationTiming?: Partial<RenameVerificationTiming>`（每个 client 一份，缺省用默认值），`retryOnContentModified` 的重试上限改为显式参数。
- `RenameIncompleteError` 从 `client.ts` 移入 `rename.ts`（否则 `rename.ts` ← `client.ts` 会成环），类名、字段（`missing` / `extra`）与消息格式保持不变。
- `renameSymbol` 里那段内联编排缩成「准备请求 + 调用校验 + 组装 placeholder」；三层策略的说明注释随之移入新 module。
- 测试：`test/lsp-client.test.ts` 改为按 client 传入 timing（删掉共享对象改写与串行注释，断言不变）；`test/lsp-rename.test.ts` 增加直接驱动 `verifyRenameCoverage` 的用例（收敛序列、extra 后收敛、预算耗尽、就绪未证实的短窗口误判、服务器拒绝 rename）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无。行为契约不变，`.openspec.yaml` 标记 `skip_specs: true`；`lsp-rename` spec 只规定「先收敛、再双向校验」这一连贯行为，未规定实现落在哪个文件。）

## Impact

- 代码：`src/lib/lsp/rename.ts`（新增校验 module + 类型/默认值 + `RenameIncompleteError`）、`src/lib/lsp/client.ts`（删除 module 级策略对象，新增创建参数，内联循环替换为一次调用）。
- 测试：`test/lsp-client.test.ts`（timing 由创建参数注入，去掉保存/恢复与串行约束）、`test/lsp-rename.test.ts`（新增 module 级用例）。
- 不涉及配置格式（`lsp.json` 不变）、公开 API、依赖或既有行为；默认 timing 数值原样保留。
