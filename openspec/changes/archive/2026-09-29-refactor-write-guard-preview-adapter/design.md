# Design

## Context

现状（行号取自改前）：

- `src/lib/write-guard.ts:23` 从 `src/opencode/edit-engine.ts` 引入 `applyEdit` 与 `normalizeToLF`，在 `buildDiffPreview`（`:74-108`）里用 `applyEdit(oldContent, change.oldText, change.newText, change.replaceAll)` 定位 `oldText`，成功则用 `generateUnifiedPatch` 出带行号的 patch，抛错则退化为参数 diff。
- `PendingChange`（`:61-68`）是 `{ oldText, newText, replaceAll? }`；`WriteGuardOptions.change` 可选。`web_fetch.ts:394` 不传 `change`。
- 真正的落盘语义分散在三个调用点：Claude Code `Edit` 用 `applyExactEdit`（`src/claude-code/edit-match.ts`，精确匹配，无模糊策略）、opencode `edit` 用 `applyEdit`（8 种 replacer）、`lsp-rename` 是整文件覆盖（`expandWorkspaceEdit` 已把 LSP 编辑在内存里套用出 `oldText` / `newText`）。
- 于是预览与落盘在 Claude Code 一侧是两套引擎；`replaceAll` 只在预览里被转手传给 opencode 的引擎。

## Goals / Non-Goals

**Goals:**

- 审批预览的定位语义由触发审批的写入工具提供，`lib/write-guard.ts` 不再 import 任何工具集模块。
- 写保护模块的 interface 变窄：它只负责「渲染 diff + 走审批」，不再持有 `replaceAll` 这类引擎参数。
- `kind: "edit"` 的调用方在类型上必须声明匹配实现，漏传是编译错误。

**Non-Goals:**

- 不改任何落盘行为：匹配算法、写入内容、快照、LSP 诊断、错误文案、审批交互（选项、取消、deny、headless、Windows）全部不动。
- 不统一两套工具集的匹配语义（它们的分歧是刻意的）。
- 不移动 `src/opencode/edit-engine.ts` 里的辅助函数。

## Decisions

### D1 `apply` 挂在 `PendingChange` 上，而不是 `WriteGuardOptions` 上

```ts
export type PendingChangeApply = (fileContent: string) => {
  readonly contentOld: string;
  readonly contentNew: string;
};

export interface FileWriteChange {
  readonly kind: "write";
  readonly newText: string;
}
export interface FileEditChange {
  readonly kind: "edit";
  readonly oldText: string;
  readonly newText: string;
  readonly apply: PendingChangeApply;
}
export type PendingChange = FileWriteChange | FileEditChange;
```

- 匹配语义属于「这次改动」，不属于「这次调用」：`web_fetch` 的落盘是整文件写入、没有匹配可言。
- 判别联合让 `kind: "edit"` 的 `apply` 成为编译期强制；扁平 interface + 可选 `apply` 会让调用方静默退回参数 diff，正是要消灭的失败模式。
- 替代方案：`WriteGuardOptions` 加可选 `preview?: (change) => {...}`。否决——可选即可能忘记，且表达不出「整文件写入不需要匹配」。
- 替代方案：保持扁平 `PendingChange` 并把 `apply` 设为必填。否决——整文件写入用不到它，会逼调用方传死值。

### D2 `apply` 返回前后文本，渲染留在写保护模块

`apply` 只回答「这次改动套到这份内容上长什么样」，`generateUnifiedPatch`、`wrapDiff`、围栏与截断由 `buildDiffPreview` 统一做。替代方案是让调用方返回渲染好的 patch 文本——三个调用点会各自复制围栏与截断逻辑，且长度上限不再统一。

### D3 行尾归一留在写保护模块，实现改为本地一行

原实现从 edit-engine 取 `normalizeToLF` 对 `apply` 的产物做 LF 归一（`\r\n` 会让 diff 的每一行都带 `\r`）。改后在 `write-guard.ts` 内保留同样的归一，但不再 import 工具集模块。这是有意的单行重复：它是一条渲染规则（预览统一按 LF 渲染），不是行尾探测算法；opencode 一侧因此逐字不变（它自己的 diff 渲染同样先 `normalizeToLF`）。

### D4 空 `old_string` 的 Edit 按整文件写入预览

两套工具集的 Edit 都有「空 `old_string` → 创建新文件或填充空文件」的语义（`claude-code/files.ts:368`、`opencode/files.ts:654`），今天靠 `buildDiffPreview` 的 `oldText === ""` 分支隐式命中。改后由调用点在构造 `PendingChange` 时显式选择 `kind: "write"`；否则会落进 `apply`（对空串必然抛错）退化成参数 diff。

### D5 `lsp-rename` 直接用展开好的前后文本

`expandWorkspaceEdit` 已经在内存里把 LSP 编辑套用成每文件的 `oldText` / `newText`，落盘就是覆盖写。预览因此直接取这一对文本（`apply: () => ({ contentOld: oldText, contentNew: newText })`），不再把整份文件内容当成 `oldString` 交给匹配引擎去找——今天它是靠 `SimpleReplacer` 恰好命中的。文件未变时预览内容与今天相同。

### D6 不变的部分

落盘内容、匹配算法、写后快照与记账、LSP 诊断、错误文案、审批交互流程、`guardWriteAccess` 的判定顺序全部保持原样。

## Risks / Trade-offs

- [归一化助手在 `lib/write-guard.ts` 与 `src/opencode/edit-engine.ts` 各有一份] → 它是一行 `replaceAll`，且消除掉的是更重的方向性错误（`lib/` 依赖工具集）；等出现第三个消费方再考虑提到共享模块。
- [预览与落盘仍可能在将来分叉：改了工具的落盘却没改 `apply`] → 新 requirement 把这条不变量写进 spec，并用「模块不内置匹配」的测试钉住模块侧；工具侧的 `apply` 与落盘共用同一个函数或同一次展开结果（Claude Code 用 `applyExactEdit`、opencode 用 `applyEdit`、rename 用 `expandWorkspaceEdit` 的产物）。
- [`claude-code` 的预览在「模糊能命中、精确命不中」的场景里从假 patch 变成参数 diff] → 这正是本 change 的目的；对能精确命中的输入（含 CRLF 文件），新旧预览逐字相同。

## Migration Plan

无。纯内部重构，无配置或数据迁移；回滚即还原这几个文件的改动。
