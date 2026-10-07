# Spec Delta

## ADDED Requirements

### Requirement: 工具结果面板

codemode 工具结果的 `details.pendant` MUST 是一块自足的面板：正文 MUST 同时给出本次调用的**脚本输入**与**脚本文本输出**，使展开面板的人无需回看工具结果正文就能看到「跑了什么、产出了什么」。

- 输入段 MUST 是脚本原文（去掉 `// @options:` 选项行内容后的源码），以 JavaScript 代码块呈现。
- 输出段 MUST 是脚本经 `text(value)` / `console.log` 产生的文本；脚本 MUST NOT 产生文本输出时，MUST 省略输出段。输出段 MUST NOT 包含脚本 `return` 的返回值与 `image(value)` 的图片。
- 两段内容 MUST 原样呈现，MUST NOT 因 `max_output_tokens` 预算被截断。
- 分段标记与代码块围栏 MUST NOT 被内容里出现的反引号串破坏：围栏长度 MUST 长于该段内容里最长的反引号串。

面板副标题 MUST 给出脚本文本输出的字符数（脚本 MUST NOT 产生文本输出时为 0），MUST NOT 需要展开面板才能知道这次产出了多少文本。字符数 MUST 是输出段文本的长度：多次 `text()` / `console.log` 产生的文本以换行拼接后计。

toolcall 进度（`onUpdate`）MUST 复用同一块面板：脚本流式产生的文本 MUST 累计进输出段，嵌套调用的进度行 MUST 继续作为面板副标题，副标题里的字符数 MUST 是截至该次更新的累计值。

脚本失败时 MUST 同样给出这块面板：运行时抛错与非法 `@options` 都 MUST 保留脚本已产生的文本输出。

#### Scenario: 面板同时给出输入与输出

- **WHEN** 脚本调用 `text("hi")` 后结束
- **THEN** 面板有输入段与输出段：输入段是脚本原文，输出段内容是 `hi`

#### Scenario: 没有文本输出时省略输出段

- **WHEN** 脚本不调用 `text()` / `console.log` 就结束（只调用工具、或只 `return` 一个值）
- **THEN** 面板只有输入段，没有输出段

#### Scenario: 输入是脚本原文

- **WHEN** 脚本原文里含有反引号串（例如模板字符串）
- **THEN** 面板的输入段仍是完整脚本原文，代码块围栏长于其中最长的反引号串，面板结构不被破坏

#### Scenario: 输出不被截断

- **WHEN** 脚本打印的文本超过 `max_output_tokens` 对应的字符预算（该预算只作用于工具结果正文）
- **THEN** 面板的输出段仍是完整文本

#### Scenario: 副标题给出输出字符数

- **WHEN** 脚本 `text("hello")` 后结束
- **THEN** 面板副标题里出现字符数 5，且不因为输出很长而省略这个数字

#### Scenario: 进度更新里的累计输出

- **WHEN** 脚本先 `text("a")`、再调用一个工具、最后 `text("b")`
- **THEN** 调用进度期间的面板输出段先出现 `a`、再出现 `a` 与 `b`，副标题显示当前嵌套调用，且字符数依次为 1 与 3（拼接后的 `a\nb`）

#### Scenario: 失败脚本的面板

- **WHEN** 脚本先 `text("partial")`，随后抛错（或 `// @options:` 行非法导致脚本未执行）
- **THEN** 面板仍带输入段，副标题给出已产生输出的字符数；前者输出段包含 `partial`、字符数为 7，后者没有输出段、字符数为 0
