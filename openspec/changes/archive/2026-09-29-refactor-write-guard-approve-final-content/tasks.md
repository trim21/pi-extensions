# Tasks

## 1. write-guard 改为按最终内容审批

- [x] 1.1 `src/lib/write-guard.ts`：删掉 `PendingChange` / `PendingChangeApply` / `FileWriteChange` / `FileEditChange` / `buildDiffPreview` / `parameterDiff`，改为导出 `FileMutation { contentOld, contentNew }` 与纯函数 `renderMutationPreview(resolvedPath, mutation)`；`WriteGuardOptions.change` 换成 `mutation`；`pnpm exec tsc --noEmit` 的错误列表就是待改的调用点
- [x] 1.2 批准分支加指纹校验（`digestIfExists` 与 `snapshotOf(contentOld)` 比对，文件不存在视作空内容），不符抛 `File has been modified since read...`；`test/write-guard.test.ts` 改为直接构造 `{contentOld, contentNew}` 的预览用例，并新增「批准后文件被外部改动则拒写」与「新建文件仍不存在时放行」两条用例；`pnpm test test/write-guard.test.ts` 通过

## 2. 调用点改为「读盘 → 算 → 审批 → 写」

- [x] 2.1 Claude Code `Edit`：审批移入 `withFileMutationQueue`，`contentOld` 取读到的原始内容、`contentNew` 取 `applyExactEdit` 的结果；空 `old_string` 分支用文件现有内容（不存在则 `""`）作 `contentOld`，`mkdir` 仍在审批之后；`pnpm test test/claude-code-tools.test.ts` 通过
- [x] 2.2 Claude Code `Write`：审批移入队列，`contentOld` 用已读到的 `original ?? ""`；`pnpm test test/claude-code-tools.test.ts` 通过
- [x] 2.3 opencode `edit`：审批移入队列，`contentOld` 取 `rawContent`、`contentNew` 取 `applied.finalContent`；`pnpm test test/opencode-edit.test.ts` 通过
- [x] 2.4 opencode `write`：改为整读目标文件（不存在则 `""`）并复用该 Buffer 判 BOM，审批移入队列；`pnpm test test/opencode-write.test.ts` 通过
- [x] 2.5 `lsp-rename`：审批仍留在写队列之外（保持「先审批全部、再逐个写盘」，避免多文件 rename 半途被拒），`contentOld` / `contentNew` 取 `expandWorkspaceEdit` 的前后文本；`pnpm test test/lsp-rename-tool.test.ts test/lsp-e2e-rename.test.ts` 通过

## 3. 同步规范与全量验证

- [x] 3.1 改 `openspec/specs/write-guard/spec.md` 的 Implementation 段：预览直接由将落盘的内容算出，模块不再为预览读盘或持有匹配引擎，并追加「批准后指纹校验」
- [x] 3.2 改 `openspec/specs/claude-code-tools/spec.md` 的 Implementation 段一句与 `README.md` 的两处描述（写保护小节、opencode `edit` 小节）
- [x] 3.3 跑 `pnpm check`、`pnpm lint`、`pnpm test` 全绿，并逐字确认 `git diff` 里没有匹配算法、写盘内容、BOM/行尾、快照、错误文案或审批交互的改动
- [x] 3.4 `openspec validate refactor-write-guard-approve-final-content --strict` 通过
