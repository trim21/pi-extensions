# Design

## Context

现状（行号取自重构前）：

- `src/lib/lsp/client.ts:115` `RenameIncompleteError`（`missing` / `extra` 两个字段 + 消息）。
- `client.ts:144-164` module 级可变导出 `renameVerificationTiming`：`pollMs: 400`、`budgetMs: 15_000`、`contentModifiedRetries: 3`、`settleSamples: 3`、`stableFloorReadyMs: 400`、`stableFloorUnreadyMs: 4_000`。
- `client.ts:170` `retryOnContentModified(fn)` 读同一对象的重试上限。
- `client.ts:1437` 附近算出 `indexReady`（就绪栅栏：等到了当前版本的诊断结论）。
- `client.ts:1477-1492` 三层策略的说明注释；`client.ts:1495-1631` 是内联实现：
  1. `referencesRequest()`（已包 ContentModified 重试）；
  2. `sendRename()`（同样包装，`MethodNotFound` 映射成「不可重命名」）；
  3. `hasPrepareProvider` 时先 `prepareRename` 取 placeholder；
  4. references 不支持（`MethodNotFound`）时跳过校验，直接返回 rename 结果；
  5. 否则：`minStableMs = indexReady ? stableFloorReadyMs : stableFloorUnreadyMs`、`deadline = now + budgetMs`、初始 `trackStability({ previous: undefined, paths: toPaths(locations), now })`；
  6. 循环：`signal.throwIfAborted()` → `stabilityAcceptable(stability, { now, minSamples: settleSamples, minStableMs })` → `expired` → 命中任一时 `sendRename()`，`edit` 为空抛「不可重命名」，然后逐文件算 `missing` / `extra`；
     - 双向一致且 `stable` → 成功返回；
     - 双向一致但未达稳定窗口 → `RenameIncompleteError([], [])`（残缺答案假稳定）；
     - `expired` 或有 `missing` → `RenameIncompleteError(missing, extra)`；
     - 其余（只有 `extra`）→ 继续轮询：`sleepWithSignal(pollMs)` 后重新采样 `trackStability`。
- 纯函数在 `rename.ts`：`editFilePaths`（edit 覆盖的文件集合）、`trackStability` / `stabilityAcceptable`（稳定窗口）、私有 `samePathSet`。

`test/lsp-client.test.ts:585` 注释「该组保持串行」，`:798-811`、`:834+` 临时改写再恢复 `renameVerificationTiming`。

## Goals / Non-Goals

**Goals:**

- 收敛与双向校验只有一份实现，最近两次 bugfix 的落点归一。
- 判定可被单喂：收敛序列、预算、就绪状态都能直接构造出来测，不必再靠改写共享对象 + 整组串行。
- 每 client 一份 timing，测试之间不再共享可变状态。
- 对外行为零变化：默认 timing 数值、请求次数（references 只多不少）、错误类型与消息格式都不变。

**Non-Goals:**

- 不改三层策略本身（稳定窗口下限、settleSamples、双向校验的判定顺序）。
- 不改 `referencesRequest` / `sendRename` / `prepareRename` 的请求构造与 ContentModified 重试语义。
- 不改 `lsp.json` 配置面（timing 不进配置，仍是测试与内部默认值）。
- 不合并 `RenameNotPossibleError`（「该位置不可重命名」）与 `RenameIncompleteError`。

## Decisions

### D1 新 module 住在 `rename.ts`，形态是「选项对象 + 全注入」

```ts
export interface RenameVerificationTiming {
  pollMs: number;
  budgetMs: number;
  contentModifiedRetries: number;
  settleSamples: number;
  stableFloorReadyMs: number;
  stableFloorUnreadyMs: number;
}

export const DEFAULT_RENAME_VERIFICATION_TIMING: RenameVerificationTiming;

export interface RenameCoverageOptions {
  /** 就绪栅栏：是否已证实拿到当前版本的诊断结论（决定稳定窗口下限）。 */
  indexReady: boolean;
  timing: RenameVerificationTiming;
  /** 进入校验前已采到的那一份 references 文件集合。 */
  initialPaths: ReadonlySet<string>;
  /** 后续采样：再请求一次 references 并给出文件集合。 */
  refetchPaths: () => Promise<ReadonlySet<string>>;
  /** 发一次 rename；返回 null 表示服务器拒绝重命名。 */
  sendRename: () => Promise<WorkspaceEdit | null>;
  /** 等待一次轮询间隔。 */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 当前时间戳（ms）。 */
  now: () => number;
  /** 构造「该位置不可重命名」错误：消息含 serverID 与位置，由调用方提供。 */
  notRenameable: () => Error;
  signal?: AbortSignal;
}

/** 等 references 收敛并双向校验 rename 覆盖，返回 edit；不满足覆盖要求时抛 RenameIncompleteError。 */
export function verifyRenameCoverage(options: RenameCoverageOptions): Promise<WorkspaceEdit>;
```

- **为什么 `initialPaths` 与 `refetchPaths` 分开**：`renameSymbol` 必须在决定是否跳过校验之前先请求一次 references（`MethodNotFound` 时直接走 rename），所以进入校验时手里已经有一份采样。若只给一个 `fetchPaths`，module 会多发一次请求，或调用方要把第一次结果丢掉——两者都改变请求次数或形状。分开之后请求次数与现在逐次一致（首次由调用方发起，之后由 module 发起）。
- **为什么注入 `now` / `sleep`**：这两条是「收敛序列」可测的唯一入口。测试可以直接喂 `[A, A, A]` 这样的采样序列与拨动的时间轴，不必真的等 400ms × N，也不必改全局常量。
- **为什么注入 `notRenameable`**：`sendRename()` 返回 null 在语义上不是校验失败而是「服务器拒绝重命名」，错误消息需要 serverID 与位置（属于 LSP 客户端上下文，不属于 rename 域）。注入保持 module 只关心校验。
- **考虑过的替代方案**：
  - 把 module 放在新文件 `rename-verify.ts`：多一层文件、没有换来更小的接口，且 `trackStability` / `editFilePaths` 就在 `rename.ts`，拆开后纯函数与它们的唯一调用者又分家。否决。
  - 让 module 自己发 references 请求（只给 `fetchPaths`）：会多一次首采样请求。否决。
  - 让 module 接收 `paths` 序列（`AsyncIterable`）而不是 `refetchPaths`：调用方要写生成器，复杂度高于收益。否决。

### D2 timing 从 module 级可变对象改成创建参数

`client.ts` 的 `export const renameVerificationTiming` 删除；`CreateInput` 新增 `renameVerificationTiming?: Partial<RenameVerificationTiming>`，client 内部解析成 `{ ...DEFAULT_RENAME_VERIFICATION_TIMING, ...input.renameVerificationTiming }` 并持有。`retryOnContentModified` 改成 `retryOnContentModified(fn, retries)`（调用点传该 client 的 `contentModifiedRetries`）。测试改为按 client 传入需要的数值，不再改写共享对象、也不再需要串行。

- 默认值数值原样搬进 `DEFAULT_RENAME_VERIFICATION_TIMING`（`pollMs: 400` 等六个字段）。
- 保留 `Partial` 覆盖语义：测试通常只关心 `pollMs` / `budgetMs` / `stableFloor*`。
- `renameVerificationTiming` 是导出符号，删除它会影响 `test/lsp-client.test.ts` 的 import——这正是本次要改的测试面，proposal 已列明。

### D3 `RenameIncompleteError` 移入 `rename.ts`

新 module 要抛它，而 `rename.ts` 已被 `client.ts` import：留在 `client.ts` 会形成 `rename.ts` → `client.ts` → `rename.ts` 的环。类名、构造函数签名、`missing` / `extra` 字段与消息格式保持不变，只换文件；`client.ts` 不再导出它，import 方（`test/lsp-client.test.ts`）改为从 `rename.js` 引入。

### D4 循环结构与判定顺序逐条保留

module 内的顺序必须与 `client.ts:1584-1631` 完全一致：先 `throwIfAborted`，再判稳定，再判预算，命中任一才发 rename；双向一致且稳定才返回；双向一致但未稳定 → `RenameIncompleteError([], [])`；`expired` 或有 `missing` → `RenameIncompleteError(missing, extra)`；只有 `extra` → sleep 后重新采样继续。**判定顺序是行为的一部分**（例如「双向一致 + 预算耗尽」返回的是 `RenameIncompleteError([], [])` 而不是 `[missing]`）。

### D5 三层策略的注释随实现迁移

`client.ts:1477-1492` 那段说明（稳定窗口 / missing / extra 各自在防什么）移到新 module 的文档注释里；`renameSymbol` 侧只留一句「校验见 verifyRenameCoverage」。

### D6 测试分两层

- `test/lsp-rename.test.ts`：直接驱动 `verifyRenameCoverage`，用假的 `now` / `sleep` / `initialPaths` / `refetchPaths` / `sendRename` 覆盖五条路径（收敛后成功；只有 extra 时继续轮询直到收敛；预算耗尽 + missing → `RenameIncompleteError(missing, extra)`；双向一致但未达稳定窗口 → `RenameIncompleteError([], [])`；`sendRename` 返回 null → `notRenameable()`）。
- `test/lsp-client.test.ts`：保留为端到端，只把 timing 改成创建参数（断言与用例名不变）。

## Risks / Trade-offs

- **注入点多（9 个选项）**：接口看起来比原来「一个循环」啰嗦，但每个注入点都对应一条可独立构造的输入；`renameSymbol` 只在唯一调用点装配一次。相比原来「常量藏在 module 级可变对象里、判定藏在闭包里」，这是可控的代价。
- **`initialPaths` / `refetchPaths` 的双入口容易被误用**（例如调用方忘了先采样）：文档注释写明「首次采样由调用方发起」，并且 `initialPaths` 是必填（TypeScript 保证）。
- **删除导出符号 `renameVerificationTiming`**：仓库内只有 `client.ts` 与 `test/lsp-client.test.ts` 引用（已确认）；它不属于扩展对外的工具 API。
- **判定顺序（D4）在改写中最容易被「顺手理顺」**：`RenameIncompleteError([], [])` 那条尤其反直觉，D6 的单测专门钉住它。
