# Proposal

## Why

上一步（`2026-09-29-refactor-write-guard-preview-adapter`）把「审批预览用哪套匹配实现」交给调用方注入，预览与落盘因此同源，但仍是**两份计算**：匹配被调用两次（一次为预览、一次为落盘），同源只靠调用方记得注入同一个函数。更彻底的做法是不做第二份计算——先读盘、算出最终内容，把这份内容拿来审批；用户批准后写的就是它，拒绝就丢弃。

这样一来，「预览 ≠ 写入」不是靠约定排除，而是没有第二份结果可供分歧。

## What Changes

- `src/lib/write-guard.ts` 的 `PendingChange`（`kind: "write" | "edit"` + `apply` 注入）换成 `FileMutation { contentOld, contentNew }`：变更前后的完整文件内容。`PendingChangeApply`、`parameterDiff` 兜底、`buildDiffPreview` 的读盘与匹配全部删除；模块不再持有任何匹配语义，也不再自己读盘算预览。
- 预览渲染成为纯函数 `renderMutationPreview(resolvedPath, mutation)`（唯一导出，供测试与审批框使用）。
- 批准后追加一次指纹校验：用户停留在对话框上的这段时间文件可能被外部改动，此时按旧内容算出的 `contentNew` 会覆盖别人的改动，指纹不符即拒写（复用 read-before-write 的「已改动」文案）。
- 五个调用点改为「先读盘 → 算最终内容 → 审批 → 写这份内容」：单文件的四处（Claude Code `Edit` / `Write`、opencode `edit` / `write`）把审批移进 `withFileMutationQueue`，审批与落盘之间不存在本进程的其它写入；也顺带修掉「先批准、再被告知文件没读过」的顺序问题。`lsp-rename` 保持「先审批全部文件、再逐个写盘」，避免多文件 rename 因中途拒绝而只改一半。
- `web_fetch` 的 `output_path` 落盘是流式写（从不把内容放进内存），保持「无变更内容、只按路径审批」的形态。
- 同步 `openspec/specs/write-guard/spec.md` 的新 requirement（改为「预览即写入内容」）与两处 Implementation 描述、`README.md`。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `write-guard`: 上一步新增的 requirement「审批预览与落盘同语义」整体替换为「审批预览即落盘内容」——预览不再由「调用方注入的匹配实现」算出，而是直接取这次写入将要落盘的内容；「无法定位时退化为参数 diff」随之消失，并新增「改动算不出时先报错再审批」「审批期间文件被改动则拒写」两条行为。

## Impact

- 代码：`src/lib/write-guard.ts`（接口与预览渲染重写）；`src/claude-code/files.ts`（Edit / Write 的读、算、审批顺序）；`src/opencode/files.ts`（edit / write 同上）；`src/lib/lsp/rename-tool.ts`（审批改为提交将要写入的内容）。
- 规范：`openspec/specs/write-guard/spec.md` 一个 requirement 的 delta + Implementation 段；`openspec/specs/claude-code-tools/spec.md` 的 Implementation 段一句。
- 测试：`test/write-guard.test.ts` 的预览用例改为直接构造 `{contentOld, contentNew}`；新增「批准后内容被外部改动则拒写」用例。
- 已知代价：opencode `write` 与 Claude Code `Write` 现在会在审批前把目标文件读进内存（Claude Code `Write` 本来就整读；opencode `write` 原本只读 3 字节判 BOM）。对话框期间该路径的写队列被占用。
