# Proposal

## Why

`lsp.json` 的 7 个客户端参数（`maxOpenDocuments` 与 6 个超时）在 `src/lib/lsp/lsp.ts` 与 `src/lib/lsp/client.ts` 之间手工逐字段搬运，一个数字要写 7 遍：`clientDefaults`（值）、`CreateInput`（可选字段）、`create()` 的 `?? clientDefaults`、`lspConfigSchema`（用户可写）、`ResolvedLspConfig`（必填字段）、`resolveConfig`（`toMs ??`）与 `startClient`（`create({...})`）。`8f8dd55` 新增 `diagnosticsSilentWaitTimeoutMs` 时正是这 7 处。

其中 6 处漏改会编译报错，唯独 `startClient`（`lsp.ts:856-863`）会**静默失效**：`CreateInput` 的字段全部可选（`test/lsp-client.test.ts` 里 30 处 `create({...})` 依赖这一点），所以一个旋钮可以「schema 收了、`resolveConfig` 解析了、内联快照钉住了」，却没被送进 `create()`——`tsc`、eslint、单测全绿，用户在 `lsp.json` 里写的值被接受、被校验、然后被丢掉。

当前只有 `maxOpenDocuments` 有「配置 → 行为」的端到端断言（`test/lsp-e2e-pyright-ruff.test.ts:108-121,253` 的 LRU 淘汰，且被 `hasPyright && hasRuff` 门控），其余 5 个旋钮没有任何测试能抓到漏接线。

这 7 个字段在 `resolveConfig` 与 `startClient` 之外没有任何读者：`ResolvedLspConfig` 与 `resolveConfig` 不被 `src/lib/lsp/` 以外的模块 import，`CreateInput` 连测试都没 import。也就是说 `ResolvedLspConfig` 的客户端那一半宽度等于载荷，纯粹是搬运层。

## What Changes

- 在 `src/lib/lsp/client.ts` 新增必填的 `LspClientOptions` 形状（`maxOpenDocuments` + 6 个超时，全部 `number`），承载这 7 个字段的唯一定义；`CreateInput` 改为「客户端身份 + `Partial<LspClientOptions>` + 测试专用覆盖」，`create()` 内部对选项应用 `clientDefaults` 的逻辑保持不变。
- `src/lib/lsp/lsp.ts` 的 `ResolvedLspConfig` 以交集形式带上 `LspClientOptions`，删掉 7 行重复声明；`resolveConfig` 仍然逐字段解析（`toMs` + 缺省），输出对象的键名与层级**保持扁平、保持不变**。
- `startClient` 由 7 行逐字段赋值改为展开 `LspClientOptions`，per-server 覆盖（`adapter.diagnosticsWaitMs`、`adapter.startupTimeoutMs`）在展开后叠加。
- 效果：`LspClientOptions` 里的字段必定抵达 `create()`，漏搬在类型上不可能；新增旋钮的编辑点从 7 处降到 4 处（`clientDefaults`、`lspConfigSchema`、`resolveConfig` + 形状自动携带）。
- 不改变任何对外行为：`lsp.json` 的字段名、缺省值、per-server 覆盖语义、`ResolvedLspConfig` 的输出形状（`test/lsp-config.test.ts` 的 8 处内联快照原样通过）都不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无。纯结构重构，行为契约不变，因此 `.openspec.yaml` 标记 `skip_specs: true`；`lsp` spec 的 Implementation 段只描述「per-server `startupTimeoutMs` / `diagnosticsWaitMs` 覆盖全局与默认值」这一语义，不涉及内部搬运方式。）

## Impact

- 代码：`src/lib/lsp/client.ts`（新增形状，`CreateInput` 收窄）、`src/lib/lsp/lsp.ts`（`ResolvedLspConfig` 声明与 `startClient` 调用）。
- 测试：不需要新增用例。`test/lsp-config.test.ts`（`resolveConfig` 输出快照，8 处）与 `test/lsp-client.test.ts`（30 处 `create({...})` 直接调用）必须原样通过，作为「行为不变」的证据；`test/lsp-e2e-pyright-ruff.test.ts` 的 `maxOpenDocuments` 端到端断言是接线仍然生效的证据（有 pyright/ruff 时）。
- 不涉及配置格式、公开 API、依赖或 spec 行为。`src/lib/lsp/lsp.ts` 之外无人 import 这两个类型，因此没有跨模块影响面。
