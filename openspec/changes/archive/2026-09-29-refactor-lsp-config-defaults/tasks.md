# Tasks

## 1. 删除 configDefaults 的转发与包装

- [x] 1.1 `src/lib/lsp/lsp.ts`：`configDefaults` 改为只表示 watch 段的 `watchDefaults`（`{ enabled, debounceMs, flushMs, maxBatch }`，去掉 `watch` 与 `maxOpenDocuments` 两层包装），文档注释写明「客户端参数缺省见 clientDefaults」。验证：`node_modules/.bin/tsc --noEmit` 通过。
- [x] 1.2 `resolveConfig` 的 4 行 watch 缺省改为读 `watchDefaults.x`，`maxOpenDocuments` 一行改为 `raw.maxOpenDocuments ?? clientDefaults.maxOpenDocuments`（与其余 6 行一致）；三处提到旧名的文档注释（`lsp.ts:72` schema 说明、`lsp.ts:82` watch 字段、`lsp.ts:170` resolveConfig 说明）一并更新；`grep -rn "configDefaults" src test bin` 为空。验证：`tsc --noEmit` 通过 + grep 为空。

## 2. 测试快照拆分

- [x] 2.1 `test/lsp-config.test.ts`：import `clientDefaults`（`../src/lib/lsp/client.js`）与 `type ResolvedLspConfig`，新增 `splitResolved(config)` 辅助（rest 解构，4 个服务层绑定全部被使用，未触发 `no-unused-vars`），文件头注释改为说明「服务层用快照、客户端参数与 clientDefaults 比对」。验证：`tsc --noEmit` 通过。
- [x] 2.2 8 处 `toMatchInlineSnapshot` 改为只快照服务层字段（`disabled` / `enabled` / `servers` / `watch`），客户端参数改为 `expect(client).toEqual(...)`；并用 `vitest run -u` 重写快照体，随后逐行 review diff 确认每个快照**只少了 7 行客户端字段**、没有丢任何服务层断言。
- [x] 2.3 新增用例「客户端参数缺省值集中在 clientDefaults」，7 个缺省值钉成唯一一处快照（`toMatchInlineSnapshot` 由 `-u` 写入）。
- [x] 2.4 覆盖不降的验证：被配置过的旋钮逐一有断言——`diagnosticsDebounceMs: "5s"` → `toEqual({...clientDefaults, diagnosticsDebounceMs: 5_000, initializeTimeoutMs: 10_000})`（字符串换算 + number 透传）；`diagnosticsDocumentWaitTimeoutMs: 3_000` 与本地覆盖 `initializeTimeoutMs: 60_000 → 10_000` → `toEqual({...clientDefaults, ...})`；`maxOpenDocuments: 8` → `toEqual({...clientDefaults, maxOpenDocuments: 8})`；其余 5 处未配置客户端参数 → `toEqual(clientDefaults)`（同时覆盖字段齐全与缺省取值）。验证：`vitest run test/lsp-config.test.ts` 44 passed。

## 3. 验证

- [x] 3.1 `vitest run test/lsp-config.test.ts test/lsp-client.test.ts` 通过（44 + 34）；`grep -c '"diagnosticsSilentWaitTimeoutMs": 1500' test/lsp-config.test.ts` 从 8 降到 1。
- [x] 3.2 `prettier --write`（两个源文件 unchanged；openspec 的 design.md 被 prettier 调整格式后 `pnpm check` 通过）、`pnpm check` 与 `pnpm lint` 全绿、`pnpm test` 全套 81 passed / 1 skipped、1230 passed / 6 skipped（较上轮 +1，即新增的缺省值用例）。
- [x] 3.3 改动范围核对（`git diff --numstat HEAD`）：本 change 只动 `src/lib/lsp/lsp.ts`（+32/-39）与 `test/lsp-config.test.ts`（+72/-72）；同一工作区里 `src/lib/lsp/client.ts`（+23/-11）属于上一个已归档的 change，本次未再改动。
