# Design

## Context

现状见 `proposal.md`。相关代码：`src/codemode/tool.ts` 的 `scriptPendant(code, subtitle)` 产出面板正文（单个 js 代码块，围栏按脚本里最长反引号串自适应）；它被四处调用——脚本解析失败、`onOutput` 进度、`onCallProgress` 进度、成功与失败结果。脚本的输出项由 `sandbox.run` 经 `onOutput` 增量回调传入（`src/codemode/sandbox.ts` 的 `runInWorker`，每次一个 frame 的 items），最终结果另有完整的 `outcome.output`。

`details.pendant` 是本仓库的 UI 约定（`src/lib/pendant.ts`），不是 pi 官方 schema；面板在 TUI/编辑器侧渲染，与进入模型上下文的工具结果正文互不影响。

## Goals / Non-Goals

**Goals:**

- 面板一次给全：脚本输入 + 脚本文本输出，空输出时不出现空段。
- 进度期间面板持续可用，不因为最终结果尚未产生而缺少输出。

**Non-Goals:**

- 不改工具结果 `content`、`details` 其它字段与 `max_output_tokens` 语义。
- 面板不承担完整审计：不展示返回值、图片、嵌套调用参数、错误堆栈（各自已有去处：正文、副标题、`details.calls`）。
- 不给面板单独设长度上限（面板不是模型上下文预算的一部分）。

## Decisions

**两段式 markdown，`## Input` / `## Output` 小标题 + 代码块。** 与 `spawn-agent` 的 `# prompt:` / `# response` 同一思路（分段标记 + 原文），但用小标题而非裸行，因为面板正文里的输出本身可能含任意文本、含 `#` 开头行。输出用代码块而非裸 markdown 是为了保真：输出是什么就显示什么，不会被渲染器重新解释。

**围栏长度逐段自适应。** 现有 `scriptPendant` 只按脚本计算围栏；输出内容同样可能含反引号串，因此把「按内容挑围栏」抽成一个 helper，输入段与输出段各算一次。用更长的围栏而非转义，保持内容逐字不变。

**进度期间累计 `text()` 项。** `onOutput` 是增量的，`execute` 里用一个累计字符串接收，每次进度更新把累计值传给 `scriptPendant`。最终结果与失败路径改用 `outcome.output` 里的完整文本，避免依赖累计变量的时序。

**输出段只放脚本的文本输出。** 最终的 `return` 值以 JSON 形式进入工具结果正文，属于脚本的返回值而不是 `text()` 的输出；图片同样只进正文。面板的目的是「输入与文本输出」，保持与 `text()` 一一对应，也让进度期间（返回值尚不存在）与最终态的面板语义一致。

**副标题里的字符数按 `text.length` 计。** 与截断预算估算（`CHARS_PER_TOKEN`）用同一个口径（UTF-16 code unit），不再引入第二套计数方式；进度期间取累计字符串的长度，最终取完整输出文本的长度，空输出为 0。格式为既有副标题后追加 ` · <N> chars output`：既有副标题（调用数 / 失败原因 / 当前嵌套调用行）保留，计数不挤掉它。

**故障路径复用同一面板。** 解析失败时脚本没执行，输入段直接用 `params.code`（含 `@options` 行原文），无输出段；运行时失败时输出段放已产生的文本。

## Risks / Trade-offs

- [面板体积可能很大] → 与工具结果正文同源，正文本来就会带上这些文本；面板只是同一内容的可视化，不为它引入第二套截断阈值。
- [进度期间输出段与正文重复渲染] → `onUpdate` 的 `content` 只放进度行，重文本只在 `details` 里，不进模型上下文，重复渲染只发生在 UI 侧。
