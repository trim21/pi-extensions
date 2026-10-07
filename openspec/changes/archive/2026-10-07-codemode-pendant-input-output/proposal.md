# Proposal

## Why

codemode 工具结果的折叠面板（`details.pendant`）正文目前只有脚本原文：展开面板能看到「跑的是什么脚本」，却看不到脚本产出了什么——脚本 `text()` / `console.log` 的文本只出现在副标题（前 80 字符）和工具结果 content 里，面板本身是一段没有结果的代码。面板应当自足：输入与文本输出都在里面。

## What Changes

- codemode 面板正文改为两段：`## Input` 放脚本原文（`js` 代码块），`## Output` 放脚本产生的文本输出（代码块）；没有文本输出时不出现 Output 段。
- 两段代码块的围栏都按各自内容里最长的反引号串自适应（沿用现有做法），输出里的 ``` 不会再截断面板。
- 面板副标题带上脚本文本输出的字符数（形如 `2 tool call(s) · 128 chars output`），让人不展开面板也能看出这次到底产出了多少文本。
- toolcall 进度（`onUpdate`）沿用同一个面板：脚本流式产生的文本累计进 Output 段，嵌套调用的进度行仍作为副标题，计数是「到目前为止」的累计值。
- 失败结果（脚本抛错、非法 `@options`）同样展示：脚本失败前已产生的文本输出进 Output 段。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `codemode`: 新增「工具结果面板」要求——`details.pendant` 的正文必须同时包含脚本输入与脚本文本输出，并规定空输出、进度更新与失败路径下的表现。

## Impact

- 代码：`src/codemode/tool.ts`（`scriptPendant` 及其调用点、进度回调里累计输出）。
- 测试：`test/codemode-tool.test.ts`（面板正文断言改用新格式，补空输出与输出含反引号的用例）。
- 行为：只有 UI 面板变化；工具结果 content、`details` 的其它字段（`calls` / `store` / `reads` / `error`）与脚本语义都不变。
