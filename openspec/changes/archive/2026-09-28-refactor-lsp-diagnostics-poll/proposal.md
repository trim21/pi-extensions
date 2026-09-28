# Proposal

## Why

「等诊断就绪」的轮询协议在 `src/lib/lsp/client.ts` 里有两份近似同构的实现：`waitForDocumentDiagnostics`（约 50 行，`client.ts:1131`）与 `waitForFullDiagnostics`（约 40 行，`client.ts:1189`）。两者逐字相同的部分是三路竞速块（`pushWait` / `waitForRegistrationChange` / `sleep`，`client.ts:1175-1181` 与 `1216-1222`）、剩余预算计算、pull 超时后转等 push 的兜底，以及 `connectionClosed` / `signal.aborted` 的循环条件；差异只有三处：pull 入口（`requestDocumentDiagnostics` vs `requestFullDiagnostics`）、就绪判据（`result.matched` vs `result.handled || result.matched`）、返回类型（`boolean` vs `void`，另加 silent 短预算只作用于 document 模式）。

后果是 locality 丢失：想确认「等诊断」的完整语义（什么时候放弃 pull、什么时候退回等 push、超时怎么算）必须在两个函数之间来回对照，改一处极易漏改另一处——例如 2026-09 修的「pull 挂起不得无限等待」只改了 document 路径，full 路径靠人肉比对确认。这类语义漂移在只有 e2e 测试（`test/lsp-client.test.ts`、`test/lsp-pull-timeout.test.ts`）覆盖的模块里尤其难发现。

## What Changes

- 在 `src/lib/lsp/client.ts` 内抽出唯一一份轮询实现 `pollUntilSettled({ pull, isSettled, budgetMs, startedAt, pushWait, signal })`，返回统一结果（`pulled` / `pushed` / `pullTimedOut` / `budgetExhausted`），把三路竞速、剩余预算、连接关闭与中断判定收进一处。
- `waitForDocumentDiagnostics` 与 `waitForFullDiagnostics` 退化为两个 adapter：只负责挑 pull 入口、给就绪判据、给预算（document 模式的 silent 短预算留在这一层）以及把统一结果映射回各自返回类型（document 的 `timedOut → await pushWait` 语义、full 的丢弃语义）。
- 不改变任何对外行为：`waitForDiagnostics` 的签名、两种模式的等待时长、`diagnosticsWaitMs` 配置语义、push 兜底与 pull 重试间隔都不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无。纯结构重构，行为契约不变，因此 `.openspec.yaml` 标记 `skip_specs: true`；`lsp` spec 的 Implementation 段本就未描述这两种等待模式的内部分工。）

## Impact

- 代码：`src/lib/lsp/client.ts`（新增一个内部函数，两个等待函数各减约 25 行）。
- 测试：不需要新增用例；`test/lsp-client.test.ts`（document 模式的行为矩阵）与 `test/lsp-pull-timeout.test.ts`（pull 挂起回归）必须原样通过，作为「行为不变」的证据。
- 不涉及配置格式、公开 API、依赖或 spec 行为。
