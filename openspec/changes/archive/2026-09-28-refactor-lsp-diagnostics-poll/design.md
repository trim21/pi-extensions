# Design

## Context

`src/lib/lsp/client.ts` 的 `createLspClient` 闭包内现状（行号取自重构前）：

- `requestDocumentDiagnostics(path)`（`client.ts:1010`）与 `requestFullDiagnostics(path)`（`client.ts:1027`）：两个 pull 入口，都返回 `PullResult`（`matched` / `handled` / `timedOut`）。
- `waitForRegistrationChange(timeout)`（`client.ts:1048`）：等待服务器注册表变化，用于「tsserver 加载 project 后才有诊断」这类场景。
- `waitForFreshPush({...})`（`client.ts:1069`）：等一条版本匹配的 push，返回 `boolean`（等到了 / 等满预算）。
- `waitForDocumentDiagnostics`（`client.ts:1131`）与 `waitForFullDiagnostics`（`client.ts:1189`）：两份近似同构的轮询。
- 预算来源：`diagnosticsDocumentWaitTimeoutMs`（缺省 5s）、`diagnosticsSilentWaitTimeoutMs`（缺省 1.5s，只在「上一份 push 为空」的文档上生效）、`diagnosticsFullWaitTimeoutMs`（缺省 10s）；pull 重试间隔 `PULL_RETRY_INTERVAL_MS = 100`。
- 公开入口 `waitForDiagnostics({ mode })`（`client.ts:1639`）按 `request.mode` 分派到两个函数，调用方（read / edit / write 工具、`lsp` 命令）不感知模式差异。

两函数的行为差异必须逐条保住：

| 维度                       | document 模式                                | full 模式                            |
| -------------------------- | -------------------------------------------- | ------------------------------------ |
| 预算                       | `lastPushEmpty ? min(5s, 1.5s) : 5s`         | 10s                                  |
| pull 入口                  | `requestDocumentDiagnostics`                 | `requestFullDiagnostics`             |
| 就绪判据                   | `result.matched`                             | `result.handled \|\| result.matched` |
| pull 超时后                | `return await pushWait`（返回是否等到 push） | `await pushWait` 后返回（结果丢弃）  |
| 预算耗尽 / 中断 / 连接关闭 | 返回 `false`                                 | 返回（`void`）                       |
| 返回值                     | `boolean`（就绪是否被证实）                  | `void`                               |

document 模式还有一个前置短路：若该路径已有「不早于最后一次内容同步」的 push 结论，直接返回 `true`（`client.ts:1141-1145`），不进入轮询。full 模式没有这一步。

## Goals / Non-Goals

**Goals:**

- 轮询协议（三路竞速、剩余预算、连接关闭 / 中断判定、pull 超时转 push 兜底）只有一份实现，改语义只改一处。
- 两个模式退化为参数与结果映射，差异在代码上三行内可读。
- 对外行为零变化。

**Non-Goals:**

- 不改 `PullResult` 的形状、`waitForDiagnostics` 的签名或 `diagnosticsWaitMs` 的语义。
- 不改 `waitForFreshPush` / `waitForRegistrationChange` / `requestDocumentDiagnostics` / `requestFullDiagnostics` 的实现，只把它们作为依赖传入。
- 不把轮询实现提到模块顶层（它依赖闭包内的 `connectionClosed`、`diagnosticListeners`、`files`、`published`）。
- 不为它新增单测（现有覆盖是 e2e / mock 服务器级别的；重构的验收就是既有用例全绿）。若实现时发现某条差异无法被现有用例覆盖，在 tasks 里补一条针对该差异的用例。

## Decisions

### D1 轮询核心返回统一结果，而不是 `boolean`

```ts
type PollOutcome = "pulled" | "pushed" | "pullTimedOut" | "budgetExhausted";

async function pollUntilSettled(params: {
  path: string;
  /** 本次等待的预算（毫秒）。 */
  budgetMs: number;
  /** 预算起点（document 模式传 request.after ?? Date.now()）。 */
  startedAt: number;
  /** 版本匹配的 push 兜底，由调用方按自己的预算创建。 */
  pushWait: Promise<boolean>;
  /** pull 入口（两种模式各自的那个）。 */
  pull: (path: string) => Promise<PullResult>;
  /** 该模式的就绪判据。 */
  isSettled: (result: PullResult) => boolean;
  signal?: AbortSignal;
}): Promise<PollOutcome>;
```

- **为什么返回四态而不是 `boolean`**：document 模式要把 `pullTimedOut` 映射成「继续等 push 的结果」，full 模式映射成「等 push 后直接返回」，两者都还要区分「预算耗尽」与「已就绪」。用 `boolean` 表达会立刻丢掉这个区分，就只能靠第二个出参或调用方重算——正是现在的问题。
- **`pullTimedOut` 不在这里等 push**：push 等待由两种模式各自的映射层完成，因为 document 需要它的布尔结果、full 不需要。把 `await pushWait` 放进核心会让返回值语义含混（等到了 push 与 pull 命中变成同一个值）。
- 循环条件 `!connectionClosed && !signal?.aborted`、剩余预算 `budgetMs - (Date.now() - startedAt)`、三路竞速与 `next === "push"` 的提前返回都原样搬入核心，`budgetExhausted` 对应原来 `remaining <= 0` 的返回点。

### D2 轮询核心保持为闭包内函数声明

它直接使用闭包里的 `connectionClosed`、`waitForRegistrationChange`、`sleep`、`PULL_RETRY_INTERVAL_MS`，提到模块顶层要额外传四个不是「数据」而是「环境」的东西。`isSettled` / `pull` / `budgetMs` / `startedAt` / `pushWait` / `signal` 是真正的参数，与「环境」区分开正是这次重构的收获。仓库约定也要求优先用 `function` 声明而不是箭头函数赋值。

### D3 前置短路留在 document 适配层

「已有不早于最后一次内容同步的 push 结论就直接返回 true」（`client.ts:1141-1145`）依赖 `published` 与 `files` 两个闭包状态，且只有 document 模式有。放在适配层，核心不需要知道它。

### D4 结果映射写在适配层

```ts
// document
const outcome = await pollUntilSettled({ ... });
return outcome === "pulled" || outcome === "pushed" || (outcome === "pullTimedOut" && (await pushWait));

// full
const outcome = await pollUntilSettled({ ... });
if (outcome === "pullTimedOut") {
  await pushWait;
}
```

两处映射都必须在注释里写清对应原来哪一条返回路径；document 那一行 `pullTimedOut → await pushWait` 是本次最容易写错的地方（漏掉就等于把「pull 挂起的服务器」的等待窗口从「等 push」改成「直接返回 false」）。

### D5 验收以既有用例为准

`test/lsp-client.test.ts` 覆盖 document 模式的完整行为矩阵（快、push、pull、silent 预算、注册表变化、超时），`test/lsp-pull-timeout.test.ts` 覆盖 pull 挂起回归。重构后这些文件不得修改（除 import 或类型层调整外的任何改动都说明行为变了）。full 模式若在既有用例里没有覆盖，实现者需在报告中说明，并补一条最小用例（mock 服务器不响应 pull → 等待在 10s 预算内结束并转入 push 兜底）。

## Risks / Trade-offs

- **`pullTimedOut` 的语义在两条路径上不同**：这是两张表里最容易被「统一」掉的差异。D4 的注释与既有用例是唯一防线；`test/lsp-pull-timeout.test.ts` 只覆盖 document 路径，full 路径若原本无覆盖，重构后仍无覆盖（风险已记录，不扩大范围）。
- **轮询核心的返回值不再是 `boolean`**：调用方只有这两个适配层，不会外泄到公开 API（`waitForDiagnostics` 仍返回 `void`）。
- **删除约 50 行后两函数更短**：适配层的三行映射读起来不如原来直观，靠注释指向原返回路径。
