# Tasks

> 全部完成，但 1-3 做的事在 4 里被撤回（见 design.md「Outcome」）。保留这份 tasks 是为了留下实测过程。

## 1. 新模块（commit 1）

- [x] 1.1 新增 `src/lib/file-diagnostics.ts`：`recordFileWithDiagnostics(deps)` 接收 `{ state, path, snapshot, cwd, getService, notify?, signal }`，内部固定「`recordRead` → `getService().lspDiagnosticsForFile(path, cwd, {notify, signal})`」，返回 `{ reads, diagnostics }`；48 行。验证：`tsc --noEmit` 通过。
- [x] 1.2 `src/claude-code/files.ts`：4 处（Read 文本、Edit 创建、Edit 替换、Write）改为一次调用；每处 5 行 → 9 行，文件 +33 / -16。`recordRead` 仍被图片读取分支使用。验证：`tsc --noEmit` 通过。
- [x] 1.3 新增 `test/file-diagnostics.test.ts`（108 行，3 个用例）：`reads` 与独立 `recordRead` 一致且 state 已写入、转发 `path`/`cwd`/`notify`/`signal`、取诊断时记账已完成。验证：`vitest run test/file-diagnostics.test.ts` 通过。

## 2. 第二套工具集（commit 2）

- [x] 2.1 `src/opencode/files.ts`：4 处（read、edit 创建、edit 替换、write）同上；不传 `notify`。文件 +27 / -11。验证：`tsc --noEmit` 通过。
- [x] 2.2 无残留：`grep -rn "lspDiagnosticsForFile" src/claude-code src/opencode` 为空（8 处全部经新模块）。

## 3. 验证

- [x] 3.1 聚焦测试：`vitest run` 8 个文件（file-diagnostics / file-reads / claude-code-tools / claude-code-signal / opencode-read / opencode-edit / opencode-write / lsp-rename-tool）175 passed。
- [x] 3.2 全量：`pnpm test` 83 files passed / 1 skipped，1250 passed / 6 skipped。
- [x] 3.3 `pnpm check` 与 `pnpm lint` 全绿；改动文件跑过 `prettier --write`。
- [x] 3.4 复核 D1：净 **+189 行**，单个调用点 5 行 → 9 行，接口 7 字段隐藏 5 行 —— 判据给出否定结论（详见 design.md D1），且实测发现 8 个调用点并不同构（设计.md D2）。

## 4. 撤回

- [x] 4.1 删除 `src/lib/file-diagnostics.ts` 与 `test/file-diagnostics.test.ts`；`src/claude-code/files.ts` 与 `src/opencode/files.ts` 恢复为改动前的两行写法（工作区回到 HEAD）。
- [x] 4.2 把实测数字、同构前提被证伪的过程与「重新评估的前提」写进 design.md，作为不重提的记录。
