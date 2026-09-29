# Design

## Context

动机见 proposal.md。实现前需要固定的事实（行号取自重构前）：

`src/lib/lsp/client.ts`：

- `clientDefaults`（`client.ts:266-283`）：7 个客户端参数的**数值**唯一来源，`as const`。
- `CreateInput`（`client.ts:285-302`）：7 个字段全部可选 + `renameVerificationTiming`（纯测试覆盖，无配置对应项）。
- `create(input)`（`client.ts:515-526`）：对每个字段做 `input.x ?? clientDefaults.x`；`input.x` 在 `startClient` 路径上恒有值，这层 `??` 服务于直接调用 `create()` 的 30 处测试。

`src/lib/lsp/lsp.ts`：

- `lspConfigSchema`（`lsp.ts:72-97`）：7 个用户可写字段，超时用 `timeoutValue`（number 或带单位字符串），`maxOpenDocuments` 用 `Type.Number({minimum:1})`。
- `configDefaults`（`lsp.ts:106-114`）：只有 `watch` 一组真缺省 + 一个冗余别名 `maxOpenDocuments: clientDefaults.maxOpenDocuments`。
- `ResolvedLspConfig`（`lsp.ts:131-149`）：`servers` / `enabled` / `disabled` / `watch` 属于 service 层，另外 7 个是客户端参数。
- `resolveConfig`（`lsp.ts:184-216`）：逐字段 `toMs(raw.x) ?? clientDefaults.x`。
- `startClient`（`lsp.ts:832-901`）：`create({...})` 的 7 行逐字段赋值（`lsp.ts:856-863`），其中两行带 per-server 覆盖 `adapter.diagnosticsWaitMs ??` / `adapter.startupTimeoutMs ??`。

依赖方向：`lsp.ts` → `client.ts`（已 import `clientDefaults` / `create` / `LspClient`）。`ResolvedLspConfig`、`resolveConfig`、`CreateInput` 在 `src/lib/lsp/` 之外无消费者；`test/lsp-config.test.ts` 消费 `resolveConfig` 的**输出形状**（8 处内联快照，每处含全部 7 个字段）。

## Goals / Non-Goals

**Goals:**

- `LspClientOptions` 里的字段在类型上必定抵达 `create()`：`startClient` 不再有「漏一行就静默失效」的位置。
- 7 个参数的定义从两处（`CreateInput` 的可选声明 + `ResolvedLspConfig` 的必填声明）收敛为一处。
- 新增旋钮的编辑点从 7 处降到 4 处：`clientDefaults`（值）、`lspConfigSchema`（用户可写）、`resolveConfig`（解析）+ 形状自动携带。

**Non-Goals:**

- 不自动生成 `lspConfigSchema` 或 `resolveConfig`（要按 `keyof typeof clientDefaults` 建 kind 表区分时长/计数，是另一个量级的改动）。
- 不改 `resolveConfig` 的输出形状与层级：8 处内联快照必须原样通过，以此作为「行为不变」的证据。
- 不动 `configDefaults` 里 `maxOpenDocuments: clientDefaults.maxOpenDocuments` 这个冗余别名，也不重命名 `configDefaults`。
- 不改任何 `lsp.json` 字段名、缺省值、per-server 覆盖语义与 `create()` 的签名形状（30 处测试调用不改）。

## Decisions

### D1 `LspClientOptions` 定义在 `client.ts`，`lsp.ts` 反向引用

值（`clientDefaults`）与消费方（`create`）都在 `client.ts`；放在 `lsp.ts` 会让 `client.ts` 反向依赖配置层，破坏既有方向。

```ts
// client.ts
export interface LspClientOptions {
  maxOpenDocuments: number;
  diagnosticsDebounceMs: number;
  diagnosticsDocumentWaitTimeoutMs: number;
  diagnosticsSilentWaitTimeoutMs: number;
  diagnosticsFullWaitTimeoutMs: number;
  diagnosticsRequestTimeoutMs: number;
  initializeTimeoutMs: number;
}

export interface CreateInput extends Partial<LspClientOptions> {
  serverID: string;
  server: LspServerHandle;
  root: string;
  directory: string;
  renameVerificationTiming?: Partial<RenameVerificationTiming>;
}
```

`interface X extends Partial<Y>` 保留 interface 风格（仓库优先 interface 而非 type 别名组合），且 30 处既有 `create({...})` 调用因为字段仍是可选而无需改动。

### D2 `ResolvedLspConfig extends LspClientOptions`，输出保持扁平

```ts
// lsp.ts
export interface ResolvedLspConfig extends LspClientOptions {
  servers: Record<string, ServerConfig>;
  enabled: Set<string> | undefined;
  disabled: Set<string> | undefined;
  watch: EffectiveWatchConfig;
}
```

- **为什么不用嵌套**（`config.client.diagnosticsDebounceMs`）：嵌套能得到一个可以整体传下去的具名子对象（展开时零枚举），代价是 `resolveConfig` 的 8 处内联快照全部改写。扁平方案把快照当作「输出形状不变」的验收证据，收益等价而验证成本为零。
- 原 `ResolvedLspConfig` 上「以下超时均为换算后的毫秒数」那句注释随字段迁移到 `LspClientOptions` 的文档注释里。

### D3 `startClient` 用 `...config` 展开，而不是逐字段列举

```ts
const overrides: Partial<LspClientOptions> = {};
if (adapter.diagnosticsWaitMs !== undefined) {
  overrides.diagnosticsDocumentWaitTimeoutMs = adapter.diagnosticsWaitMs;
}
if (adapter.startupTimeoutMs !== undefined) {
  overrides.initializeTimeoutMs = adapter.startupTimeoutMs;
}
const client = await create({
  serverID: adapter.id,
  server: handle,
  root,
  directory: cwd,
  // 客户端参数整体来自生效配置（ResolvedLspConfig extends LspClientOptions），
  // 这里不做逐字段搬运，避免新增旋钮时漏接线而静默失效。
  ...config,
  ...overrides,
});
```

- 展开 `config` 会把 `servers` / `enabled` / `disabled` / `watch` 一并带进对象字面量，`create()` 只读自己知道的键，运行时无影响；类型上对象字面量的 excess property check 不作用于 spread 引入的属性，故可编译。
- **为什么不用 rest 解构取子集**（`const { servers, enabled, disabled, watch, ...options } = config`）：枚举的是 service 层 4 个键（稳定），语义上更好，但 `@typescript-eslint/no-unused-vars` 未开 `ignoreRestSiblings`，四个未使用的绑定会报错，而仓库约定不为此改 eslint 配置。
- **为什么不用显式 7 字段赋值**：那正是要消除的搬运本身；只要还需要逐字段列举，漏一行就静默失效的结构就还在。
- per-server 覆盖语义等价性：`adapter.diagnosticsWaitMs ?? config.diagnosticsDocumentWaitTimeoutMs` 等价于 `{...config, diagnosticsDocumentWaitTimeoutMs: adapter.diagnosticsWaitMs}`——只有当 adapter 值 `!== undefined` 时才写覆盖键，`??` 的「空值不覆盖」行为由 `if` 承担。

### D4 验收标准是「静默失效点在类型上消失」

`LspClientOptions` 增字段 → `ResolvedLspConfig`（extends）与 `create()`（Partial）自动要求该字段 → `resolveConfig` 必须产出它（否则编译错）→ `...config` 必定带上它。链条上没有任何一处可以「漏掉而不报错」。

## Risks / Trade-offs

- [依赖 spread 的 excess property 豁免，比较隐晦，后来者可能「顺手修好」为显式列举] → 在 `startClient` 该处留一行注释说明意图（不逐字段搬运是为了不出现漏接线的静默失效）。若 `tsc` 不接受该展开，回退方案是按 D2 改为嵌套 `client` 子对象并同步 8 处快照。
- [`...config` 会把 service 层键塞进 `create()` 的入参，读起来不如显式列举干净] → `create()` 的参数类型仍只声明它认识的键，运行时行为不受影响；这是为「零枚举」付的唯一代价。
- [类型收敛后 `CreateInput` 的 7 个字段语义从「可选覆盖」变成「Partial 的客户端选项」，读代码时需要跳一次类型] → `LspClientOptions` 带文档注释，并在 `CreateInput` 处说明它是客户端可调项的可选覆盖。
- 无行为变化，故无迁移与回滚需求：改动不落在任何运行时分支上，`git revert` 即回退。
