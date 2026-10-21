# Design

## Context

两套 Bash 工具都在工具层拼接状态行：`src/claude-code/shell.ts` 处理 `BashInterruptedError` 的 `timeout` / `aborted`，`src/opencode/bash.ts` 同样处理这两个分支。命令输出、截断提示和状态行目前拼成一段普通文本。沙箱状态提示已经由 `src/bwrap/runtime.ts` 的 `sandboxHintBlock` 生成独立的 `<system-reminder>` 文本块，本次沿用同一标记形态。

## Goals / Non-Goals

**Goals:**

- 超时与用户取消的状态行对模型呈现为系统注入信息，而不是命令输出。
- 两套工具的标记格式一致。
- 除状态行外，文本、`details` 与 `structuredResult` 不变。

**Non-Goals:**

- 不处理非零退出状态行（`Exit code N` / `Command exited with code N.`）。
- 不处理截断提示与沙箱状态提示。
- 不改变超时与取消的判定逻辑或错误类型。

## Decisions

**状态行仍留在原文本块内，只把状态行本身包进 `<system-reminder>`。**
保持 `输出\n\n<system-reminder>状态</system-reminder>` 的单文本块结构，改动最小，也不改变现有内容块的顺序与数量。备选方案是像沙箱提示那样拆成独立文本块；那样会让超时/取消路径的内容块数量与其他路径不同，增加测试改动，但没有额外收益。

**共用格式化函数放在 `src/lib/bash-tool.ts`。**
该文件已经是两套 Bash 工具共享的模块，新增 `systemReminder(text)` 返回固定格式字符串，两处调用点各自拼接输出。备选方案是放在 `src/bwrap/runtime.ts`，但那里负责沙箱语义，状态行的文案与拼接属于工具层。

## Risks / Trade-offs

- [模型把 `<system-reminder>` 当成命令输出的一部分] → 该标记与仓库内其他系统提示一致，且放在命令输出之后、独立成段，语义清晰。
- [测试只覆盖快照，漏掉块结构变化] → 本次不改变块结构；更新现有文本断言即可覆盖。
