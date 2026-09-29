# Design

## Outcome（先读这段）

本 change 已按下面的设计**实现并实测**，随后**整体撤回**：新模块与测试删除，8 个调用点恢复原来的两行写法。撤回依据是仓库自己的判据（`2026-09-29-refactor-file-read-accounting` 的 design.md D1「**接口宽度 ÷ 被隐藏的行为**」）与实测数字，见「实测结果」。

**不要重提「把文件工具的诊断收尾抽成一个模块」**，除非出现「重新评估的前提」里列出的变化。

## Context

改动前的调用点（8 个，形状一致的两行）：

| 工具                           | 记账 + 诊断            | 传 notify |
| ------------------------------ | ---------------------- | --------- |
| claude-code `Read`（文本）     | `files.ts:286` / `288` | 是        |
| claude-code `Edit`（创建分支） | `files.ts:384` / `387` | 是        |
| claude-code `Edit`（替换分支） | `files.ts:447` / `457` | 是        |
| claude-code `Write`            | `files.ts:546` / `553` | 是        |
| opencode `read`                | `files.ts:555` / `558` | 否        |
| opencode `edit`（创建分支）    | `files.ts:668` / `669` | 否        |
| opencode `edit`（替换分支）    | `files.ts:712` / `718` | 否        |
| opencode `write`               | `files.ts:836` / `837` | 否        |

不纳入的相邻调用点：图片读取（只记账、不取诊断）、`rename-tool.ts:225`（多文件、诊断拼接、subtitle 是重命名摘要）。

既有接缝：`withFileMutationQueue` 来自 pi SDK；`appendLspDiagnosticText`（`src/lib/lsp/diagnostic.ts:77`）与 `formatSubtitlePath`（`src/lib/path.ts:103`）已是共享纯函数；`recordRead` 返回可直接放进 `details` 的片段；`LspService.lspDiagnosticsForFile` 的注释已声明它「read / edit / write 用」。

## 实测结果

实现形状：`recordFileWithDiagnostics({ state, path, snapshot, cwd, getService, notify?, signal })` 返回 `{ reads, diagnostics }`，内部固定「先 `recordRead`、后 `lspDiagnosticsForFile`」。

| 项                                   | 数字            |
| ------------------------------------ | --------------- |
| 新增 `src/lib/file-diagnostics.ts`   | 48 行           |
| 新增 `test/file-diagnostics.test.ts` | 108 行          |
| `src/claude-code/files.ts`           | +33 / -16       |
| `src/opencode/files.ts`              | +27 / -11       |
| 净                                   | **+189 行**     |
| 单个调用点                           | 5 行 → **9 行** |

**调用点变长而不是变短**：7 个字段在参数对象里逐个写出来，8 处共为「两行调用」付了 4 行/处的保费。重复没有被消除，只是从「两行调用」换成了「七个具名字段」。按 D1 的判据（7 字段 + 调用点 9 行，隐藏 5 行）这是它描述的浅模块。

### 实测发现的第二个事实：8 个调用点并不同构

claude-code 的 `Edit`（创建）/`Edit`（替换）/`Write` 在记账与取诊断之间夹着 `signal?.throwIfAborted()`（先记账 → 算 diff → 检查取消 → 等诊断）；opencode 四处与 claude-code `Read` 没有这个检查。要一次调用覆盖两者必须挑一个顺序，实现里选了保住记账（文件已写盘，取消后仍应记账，否则下一次 Edit 会要求重新 Read——正是前一次 change 修掉的症状），代价是：**取消恰好落在诊断等待期间时，claude-code 的 Edit/Write 现在报取消、以前返回成功**。proposal 里「行为零变化」因此不成立。

## Decisions

### D1 撤回：接口宽度大于被隐藏的行为

前一次 change 的 D1 原文：「一个 5-7 参数、带审批回调与三种守卫枚举的事务，不比它隐藏的 4 行更小——是浅模块。」本次实测与该判据一致地给出否定结论：

- 被隐藏的行为：`recordRead` 1 行 + `getService()` 调用 1 行 + 转发 `notify`/`signal`/`cwd`，每站 5 行。
- 接口：7 字段参数对象 + 2 字段返回值。
- 净收益：一条顺序（「记账 → 取诊断」）的唯一出处；净成本：+189 行、每站 +4 行、一处取消语义覆盖面变化、以及「同构」这个前提被证伪。

### D2 「同构」前提不成立

见上文「第二个事实」。3 个 claude-code 写入站点的取消边界与另外 5 处不在同一位置，把两者压成一次调用就必然改掉其中一侧的语义。这比行数更能说明这次不该抽模块：被抽出来的不是一件「同一个东西」，而是两行 + 一条随站点变化的取消策略。

### D3 撤回后保留的判断

- `appendLspDiagnosticText` / `formatSubtitlePath` / `recordRead` 三个既有模块是这些调用点里真正均匀的部分，它们已经各自是共享的，不需要再加一层。
- opencode 四处的诊断调用不传 `notify`、claude-code 四处传，是现状差异，本次既没有统一也没有判定为缺陷；若判定为缺陷，那是独立的行为变更（要动 spec）。

## 重新评估的前提

满足任一条时才值得重新考虑抽模块：

- 调用点数量显著增长（例如 15+）**且**取消边界位置统一（例如所有站点都改成同一种「先记账 → 再检查取消 → 再等诊断」的写法）。
- 形态改变到不再是「给 7 个字段转发」：例如 registration 期建立、把 `state` / `getService` 收进闭包的工厂（`createFileDiagnostics({ state, getService })` → `touch(path, snapshot, { cwd, notify, signal })`），但那会把调用点的重复换成生命周期耦合，收益仍未验证。
- 顺序下沉到 LSP 侧（`LspService` 提供「记账 + 报诊断」的单一入口），此时工具层不再需要这个模块。

## Risks / Trade-offs

- [撤回后再遇到「诊断收尾」的重复感] → 本文件即为记录：先量接口宽度与被隐藏行为的比值，再决定。
- [取消语义差异被遗忘] → D2 记录了它；若要让 claude-code 三站点的取消落在诊断等待期间报取消，那是一次独立的行为变更。
