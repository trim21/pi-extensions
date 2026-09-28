# Tasks

## 1. write-guard 改为调用方注入匹配

- [x] 1.1 把 `PendingChange` 改成 `kind: "write"` / `kind: "edit"` 的判别联合，新增 `PendingChangeApply`，从 interface 里移除 `replaceAll`；`pnpm check` 通过（类型错误会指向所有待改的调用点）
- [x] 1.2 重写 `buildDiffPreview`：整文件写入分支照旧，替换分支改为调用 `change.apply(fileContent)`，抛错时退化为参数 diff；行尾归一改为模块内本地的 LF 归一，删除 `src/opencode/edit-engine.js` 的 import
- [x] 1.3 改 `test/write-guard.test.ts`：`buildDiffPreview` 用例自备匹配实现（成功/抛错两条路径），并新增两条断言——模块不内置匹配引擎（`apply` 抛错时即便文件里有该文本也退化为参数 diff）、展示的 patch 由 `apply` 返回的前后文本决定而非 `oldText`/`newText`；`pnpm test test/write-guard.test.ts` 通过且既有快照不变

## 2. 调用点声明各自语义

- [x] 2.1 Claude Code `Edit`：`old_string` 为空走 `kind: "write"`，否则注入 `applyExactEdit` 构成的 `apply`；`pnpm test test/claude-code-tools.test.ts` 通过
- [x] 2.2 Claude Code `Write` 与 opencode `write`：改为 `kind: "write"`；`pnpm test test/claude-code-tools.test.ts test/opencode-write.test.ts` 通过
- [x] 2.3 opencode `edit`：注入 `applyEdit` 构成的 `apply`；`pnpm test test/opencode-edit.test.ts` 通过
- [x] 2.4 `lsp-rename`：用 `expandWorkspaceEdit` 展开好的 `oldText` / `newText` 直接构成 `apply`（不再读盘匹配）；`pnpm test test/lsp-rename-tool.test.ts test/lsp-e2e-rename.test.ts` 通过

## 3. 同步规范与全量验证

- [x] 3.1 改 `openspec/specs/write-guard/spec.md` 的 Implementation 段：预览的定位由写工具提供匹配实现，写保护模块不再与 opencode-edit 共享匹配引擎
- [x] 3.2 改 `openspec/specs/claude-code-tools/spec.md` 的 Implementation 段一句：`src/lib/write-guard.ts` 不再复用 edit-engine 的 `applyEdit` / `normalizeToLF`；顺带改正 `README.md` 的两处同样描述（写保护小节与 opencode `edit` 小节）
- [x] 3.3 跑 `pnpm check`、`pnpm lint`、`pnpm test` 全绿，并逐字确认 `git diff` 里没有落盘路径、错误文案或审批交互的改动
- [x] 3.4 `openspec validate refactor-write-guard-preview-adapter --strict` 通过
