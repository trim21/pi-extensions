# Proposal

## Why

`src/lib/write-guard.ts` 用 opencode 的匹配引擎（`src/opencode/edit-engine.ts` 的 `applyEdit`）生成审批对话框里的 diff 预览，而 Claude Code 风格的 `Edit` 落盘用的是自己的精确匹配（`src/claude-code/edit-match.ts` 的 `applyExactEdit`）。于是用户批准的是一个由另一套引擎算出来的改动：模糊匹配能命中、精确匹配命不中时，对话框会展示一次实际写不进去的替换。

同时这把两套工具集共用的写保护模块绑在了其中一套的内部实现上——写保护是 `lib/` 层，却 import 了某个工具集的匹配引擎。

## What Changes

- `src/lib/write-guard.ts` 不再引用 `src/opencode/edit-engine.ts`：删除内置匹配调用，改为由调用方声明「这次改动如何应用」。
- `PendingChange` 按改动分两种形状：整文件写入（`kind: "write"`，只有 `newText`）与替换（`kind: "edit"`，带 `apply`）。`replaceAll` 从写保护模块的 interface 里移除——它此前只是转手喂给那个引擎，现在留在各自的调用方。
- 调用点各自声明语义：Claude Code `Edit` 注入 `applyExactEdit`（空 `old_string` 走整文件写入）、opencode `edit` 注入 `applyEdit`、`lsp-rename` 直接用内存里展开好的前后文本；两处 `write` 与 `web_fetch` 的落盘是整文件写入或无预览。
- 预览渲染（patch 生成、围栏、截断、行尾归一）仍归写保护模块所有。
- 修正 `openspec/specs/write-guard/spec.md` 与 `openspec/specs/claude-code-tools/spec.md` 的 Implementation 段：现文写「与 opencode-edit 共享匹配引擎」，改后不再如此。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `write-guard`: 新增一条 requirement——审批预览必须由触发审批的那个写入工具自己的匹配实现算出，预览与其后真正写入的内容同语义。

## Impact

- 代码：`src/lib/write-guard.ts`（`PendingChange` 改形状、`buildDiffPreview` 改为调用注入的 `apply`）；`src/claude-code/files.ts`（Edit 的审批参数）；`src/opencode/files.ts`（edit 的审批参数，write 走整文件形状）；`src/lib/lsp/rename-tool.ts`（rename 的审批参数）；`src/web/fetch.ts` 不传变更预览、无需改。
- 规范：`openspec/specs/write-guard/spec.md` 新增 requirement + Implementation 段改写；`openspec/specs/claude-code-tools/spec.md` 的 Implementation 段一句改写。
- 测试：`test/write-guard.test.ts` 的 `buildDiffPreview` 用例改为自备匹配实现，并新增「模块不内置匹配引擎」与「预览由 `apply` 的返回值决定」两条断言。
- 不涉及配置格式、公开工具名、依赖或落盘行为。
