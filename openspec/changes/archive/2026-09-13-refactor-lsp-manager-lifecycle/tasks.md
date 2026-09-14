# Tasks: refactor-lsp-manager-lifecycle

## 1. LspManager

- [x] 1.1 `src/lib/lsp/lsp.ts`：新增 `LspManager`（`createLspManager(pi, options, hooks)`），收拢 session_start（await 配置加载 + 校验 + disabled 判定 + onEnabled 回调）、session_shutdown（shutdownAll）、agent_start/end（status 刷新，仅 enabled）；`mustLazyGetService()` 永不抛错，disabled/未创建时返回共享 no-op service；移除 `registerLsp`。验证：`pnpm exec tsc --noEmit` 通过
- [x] 1.2 `/lsp-stop` `/lsp-start` `/lsp-reload` 命令改为 load 时无条件注册，handler 走 mustLazyGetService，disabled 时提示"LSP not configured"类信息；status attach 随 manager 生命周期。验证：`pnpm exec tsc --noEmit` 通过

## 2. 文件工具解耦

- [x] 2.1 `src/claude-code/files.ts`：`registerFileTools(pi, state, getService)` 签名改造，read/edit/write execute 内经 `getService()` 取 service；LSP 工具（rename + inspect）注册移入 `hooks.onEnabled`，`recordReads` 捕获 state 闭包；default export 改用 `createLspManager`。验证：`pnpm exec tsc --noEmit` 通过
- [x] 2.2 `src/opencode/files.ts`：同款改造（无 recordReads）。验证：`pnpm exec tsc --noEmit` 通过

## 3. 测试

- [x] 3.1 测试基建：mock pi 的 `on` 改为捕获 handler，提供 `emitSessionStart(ctx)` 辅助，工具执行前触发；涉及 `test/claude-code-tools.test.ts`、`test/lsp-e2e-*.test.ts` 的 loadFileTools / loadTools。验证：改造后现有断言语义不变
- [x] 3.2 新增条件注册断言：无 lsp.json 时注册清单不含 LSP 工具；有配置（fixture project 或临时 lsp.json）时含；`claude-code-tools.test.ts` 注册清单断言相应更新。验证：`pnpm test -- claude-code-tools lsp-e2e-inspect lsp-e2e-rename` 通过
- [x] 3.3 降级语义测试：disabled 时 edit/write 正常完成且诊断输出为空；/lsp-start 等命令提示不报错（可并入 3.2 的测试文件）。验证：`pnpm test` 相关用例通过

## 4. 全量验证

- [x] 4.1 `pnpm check`（tsc --noEmit + prettier --check）与 `pnpm lint` 全绿
- [x] 4.2 `pnpm test` 全量通过（928+ 测试不回归）

## 5. lint 规则增强（应用中追加）

- [x] 5.1 启用 `@typescript-eslint/no-unnecessary-condition`（禁多重optional调用/恒真条件等），并修复全仓既有违规（约 21 个文件：bwrap / talk / vision-agent / lsp / opencode 等，均为删多余 `?.`、恒真比较、非可空 `??` 的机械修复）。验证：`pnpm lint` 全绿
