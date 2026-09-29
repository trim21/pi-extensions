# Tasks

## 1. 形状收敛

- [x] 1.1 `src/lib/lsp/client.ts`：新增 `export interface LspClientOptions`（`maxOpenDocuments` + 6 个超时，全为 `number`，文档注释写明「解析后的毫秒数 / 计数」），把 `CreateInput` 改为 `extends Partial<LspClientOptions>` 并删掉其中 7 行逐字段声明；`create()` 与 `clientDefaults` 不动。验证：`node_modules/.bin/tsc --noEmit` 通过。
- [x] 1.2 `src/lib/lsp/lsp.ts`：`ResolvedLspConfig` 改为 `extends LspClientOptions`，删掉其中 7 行逐字段声明，从 `./client.js` 的 import 中加入 `LspClientOptions`（type import）；`resolveConfig` 不改一行。验证：`node_modules/.bin/tsc --noEmit` 通过，且 `test/lsp-config.test.ts` 通过（8 处内联快照即输出形状未变）。
- [x] 1.3 `src/lib/lsp/lsp.ts` 的 `startClient`：把 `create({...})` 的 7 行逐字段赋值换成 `...config` 展开，per-server 覆盖（`adapter.diagnosticsWaitMs` / `adapter.startupTimeoutMs`）改为条件写入 `overrides: Partial<LspClientOptions>` 后 `...overrides` 叠加；加一行注释说明「不逐字段搬运是为了不出现漏接线的静默失效」。验证：`tsc --noEmit` 通过——实测展开未被 excess property check 拒绝，未触发 design 里的嵌套回退方案。per-server 覆盖语义等价性另有类型依据：两字段类型为 `number | undefined`（`adapter.ts:47,49` / `server-config.ts:328-329`），故 `!== undefined` 判定与原先的 `??` 完全等价。
- [x] 1.4 确认搬运已消除：`grep -n "config\.diagnostics\|config\.initializeTimeoutMs\|config\.maxOpenDocuments" src/lib/lsp/lsp.ts` 为空（已确认）；`grep -n "diagnosticsSilentWaitTimeoutMs" src/lib/lsp/lsp.ts` 剩 4 处——schema 文档注释 + schema 字段（`lsp.ts:90-91`）、`resolveConfig` 的两行（`lsp.ts:204-205`），即 design 的 Non-Goals 里明确保留的手改点（schema 与解析仍是逐字段的），`startClient` 已不再出现。

## 2. 行为不变的证据

- [x] 2.1 `node_modules/.bin/vitest run test/lsp-config.test.ts test/lsp-client.test.ts` 通过（77 passed），且 `git diff --stat test/` 为空——测试文件零改动，`resolveConfig` 输出形状与 `create()` 入参形状未变。
- [x] 2.2 `git diff --stat` 只有 `src/lib/lsp/client.ts`（+23/-11）与 `src/lib/lsp/lsp.ts`（+18/-19）两个源码文件（外加 openspec 的 change 目录）。
- [x] 2.3 `node_modules/.bin/prettier --write` 两个文件（均 unchanged），`pnpm check`（tsc + prettier --check）与 `pnpm lint` 全绿。
- [x] 2.4 用探针实测「漏接线在类型上不可能」：临时给 `LspClientOptions` 加一个 `zzProbeMs: number` 字段，`tsc --noEmit` 只报一处错——`resolveConfig` 的返回字面量缺该字段（`lsp.ts(189,3) error TS2741`），`startClient` 无需任何改动。随后移除探针，`tsc` 复检通过、`grep zzProbeMs src test` 无残留。

## 3. 汇报

- [x] 3.1 报告两个文件的净行数变化、`LspClientOptions` 增字段时仍需手改的位置（`clientDefaults` / `lspConfigSchema` / `resolveConfig`），以及未覆盖的残余风险（`maxOpenDocuments` 之外的旋钮仍无「配置 → 行为」端到端断言）。另记：`pnpm test` 全套 81 passed / 1 skipped、1229 passed / 6 skipped，含 gopls / tsls / pyright / ruff 的 e2e；`test/lsp-e2e-pyright-ruff.test.ts` 的 `maxOpenDocuments` 端到端断言（写 `.pi/lsp.json` 容量 2 → 三个文件连续 edit 各自仍拿到诊断）通过，是「展开仍把配置值送进 client」的运行时证据。
