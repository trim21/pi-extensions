# codemode Specification

## Purpose

让模型用一段 JavaScript 编排本仓库的工具：脚本在没有宿主能力的 QuickJS VM 里执行，只有脚本的输出与返回值进入模型上下文；脚本发起的工具调用与模型直接调用走同一套实现，需要人工授权的调用在脚本内直接失败。

## Requirements

### Requirement: 工具注册与可调用工具集合

扩展 MUST 注册名为 `codemode` 的工具，并 MUST 在注册时把脚本可调用的工具集合渲染进工具描述，为每个工具给出名字、说明、参数类型与返回类型。返回类型 MUST 按该工具的 `structuredSchema` 渲染——可调用集合里每个工具都声明了它，因此每个条目都有确定的返回类型。

每个工具的说明 MUST 是它 `description` 的**全文**，包含多行描述的每一行（按 JSDoc 注释渲染）；MUST NOT 只取首行，也 MUST NOT 做任何截断——工具作者写在描述里的约束必须在 codemode 里同样可见。

可调用集合 MUST 只包含本仓库工具总线上**声明了 `structuredSchema`** 的工具；在此之上，MUST 包含所有 codemode-only 工具，且对非 codemode-only 的工具 MUST 再与当前 active 工具列表求交（取不到 active 列表时不过滤）。codemode-only 工具不在 active 列表里是常态，MUST NOT 因此把它排除。这条准入条件 MUST 是唯一的集合规则：MUST NOT 再维护手工的工具名单（黑名单会随工具增减而漂移）。理由是脚本拿到的返回值必须有确定的形状：只给文本的工具在脚本里既不能当数据用（得解析文本），也没有返回类型能写进声明。

由此天然不在集合里、且各自理由独立成立的例子：`codemode` 自身与 `spawn-agent`（没有结构化输出）、两套文件工具集的读写工具（脚本用 `fs.read` / `fs.write`，不重复一套为 LLM 上下文设计的行号/锚点语义）、两套工具集的搜索工具（脚本用 `call("Bash", { command })` 跑 `rg` / `grep`，走同一个沙箱、拿得到退出码，还能拼管道）、`lsp-rename`（写工具）、talk 工具与会话工具（会把执行时间交给用户或另一个 agent 的回答）。这些工具 MUST NOT 需要写进特殊名单：它们没有声明结构化输出，因此自然不在集合里。

脚本 MUST NOT 能调用不在集合里的任何工具名。

#### Scenario: 描述列出可调用工具

- **WHEN** 获取 `codemode` 的工具描述
- **THEN** 描述包含总线上每个声明了 `structuredSchema` 且（属于 codemode-only 或当前 active）的工具的名字、说明与参数类型声明，且不含其它任何工具名

#### Scenario: 描述给出每个工具的返回类型

- **WHEN** 某个工具声明了 `structuredSchema`
- **THEN** 描述里它的返回类型按该 schema 渲染；没声明 schema 的工具不出现（因此不存在「未声明就渲染成文本」的条目）

#### Scenario: 返回类型字段的说明渲染成注释

- **WHEN** `structuredSchema` 的某个字段带 `description`
- **THEN** 描述里该字段的类型声明上方渲染这段 `description`：单行用 `//`，多行按 JSDoc 渲染；嵌套对象与数组元素的字段同样递归渲染，没有 `description` 的字段不产生注释

#### Scenario: 多行说明完整渲染

- **WHEN** 某个可调用工具的 `description` 有多行
- **THEN** 描述里该工具的 JSDoc 注释包含这个 `description` 的每一行，MUST NOT 只保留第一行

#### Scenario: 集合外的工具不可调用

- **WHEN** 脚本调用一个不在总线上的工具名，或一个已注册但没有声明 `structuredSchema` 的工具名
- **THEN** 该调用在脚本内以错误失败，不产生任何宿主副作用

#### Scenario: 未启用的工具不可调用

- **WHEN** 脚本调用一个已注册、已声明结构化输出但不是 codemode-only 的工具，而它当前不 active（例如子代理工具白名单之外的工具）
- **THEN** 该调用失败，不执行该工具

#### Scenario: codemode-only 工具可调用

- **WHEN** 脚本调用一个已注册为 codemode-only 的工具
- **THEN** 该调用执行该工具，即使它不在模型可见的工具清单与 active 列表里

#### Scenario: codemode-only 工具出现在描述里

- **WHEN** 某个已注册工具是 codemode-only 且声明了 `structuredSchema`
- **THEN** `codemode` 的工具描述里有它的名字、说明、参数类型与返回类型

#### Scenario: 脚本自身不可再调用 codemode

- **WHEN** 脚本尝试调用 `codemode`
- **THEN** 该调用失败，不会递归启动新的脚本

#### Scenario: 脚本不可调用 spawn-agent

- **WHEN** 脚本尝试调用 `spawn-agent`（即使该工具已注册且 active）
- **THEN** 该调用在脚本内以错误失败，不启动任何子代理，`codemode` 的工具描述里也不出现它的参数声明

#### Scenario: 脚本不可调用文件读写工具

- **WHEN** 脚本尝试调用 `Read` / `Edit` / `Write`（或小写的 `read` / `edit` / `write`），无论它们是否已注册且 active
- **THEN** 该调用在脚本内以错误失败，工具 MUST NOT 被执行，`codemode` 的工具描述里也不出现它们的参数声明；脚本要碰文件就用 `fs.read` / `fs.write`

#### Scenario: 脚本不可调用搜索工具

- **WHEN** 脚本尝试调用 `Grep` / `Glob`（或小写的 `grep` / `glob`），无论它们是否已注册且 active
- **THEN** 该调用在脚本内以错误失败，工具 MUST NOT 被执行，`codemode` 的工具描述里也不出现它们；脚本要搜文件用 `call("Bash", { command })` 跑 `rg`

#### Scenario: 没有结构化输出的工具不可调用

- **WHEN** 脚本尝试调用 `lsp-rename` / `talk-ask` / `talk-send` / `TodoWrite`（或对应的小写名），或任何其它没有声明 `structuredSchema` 的工具
- **THEN** 该调用在脚本内以错误失败，工具 MUST NOT 被执行，`codemode` 的工具描述里也不出现它们（没有 schema 就没有返回类型可渲染）

#### Scenario: 脚本用 Bash 拿退出码与输出

- **WHEN** 脚本 `call("Bash", { command: "rg -q needle file" })`
- **THEN** 调用 resolve 为 `Bash` 的结构化结果（`{ exitCode, output }`），脚本据 `exitCode` 分支，命令本身的非零退出不是调用失败

#### Scenario: 声明了结构化输出却没给载荷

- **WHEN** 脚本调用一个声明了 `structuredSchema` 但返回结果里没有 `structuredResult` 的工具
- **THEN** 该调用在脚本内以 `CallFailedError` 失败（运行时复核由工具总线负责），脚本可以捕获并继续

### Requirement: 脚本执行隔离

脚本 MUST 在本扩展自带的 QuickJS VM 里执行，VM 内 MUST NOT 存在宿主能力（Node API、文件系统、网络、timer、模块加载、`WebAssembly`）；脚本唯一的出口是注入的工具，而这些工具由主线程执行。VM MUST 跑在 worker 线程里，使死循环脚本能被终止而不阻塞会话。VM 的 wasm 模块 MUST 在注册 `codemode` 工具时编译一次，每次执行复用同一份编译结果，且每次执行 MUST 使用新的 VM 实例。只有脚本的输出与返回值进入模型上下文，脚本内部发起的工具调用 MUST NOT 在会话记录里产生工具调用条目。

#### Scenario: 脚本无法触达宿主能力

- **WHEN** 脚本检查 `process` / `require` / `fetch` / `setTimeout` / 文件 API
- **THEN** 这些能力在脚本内不存在，尝试使用会失败且不产生宿主副作用

#### Scenario: 嵌套调用结果不进入上下文

- **WHEN** 脚本调用若干工具并只输出其中一部分
- **THEN** 模型只收到脚本输出的内容，未输出的调用结果不出现，会话记录里也没有这些调用

#### Scenario: 死循环脚本不阻塞会话

- **WHEN** 脚本在 VM 里死循环
- **THEN** 会话继续正常工作，超出时限后该 worker 被终止

### Requirement: 嵌套调用的执行

脚本发起的每次嵌套调用 MUST 经本仓库工具总线的 `executeCodemodeTool` 执行（参数校验、结构化结果复核与错误归一化由总线负责）。codemode 内 MUST NOT 出现任何审批：需要人工授权的嵌套调用（脚本 `fs.write` 写工作区外、`Bash` 申请沙箱外执行）MUST 在脚本内以 `CallFailedError` 直接失败，错误信息 MUST 说明该操作需要授权并建议改为直接调用该工具；这些调用 MUST NOT 产生宿主副作用。脚本之外的直接调用（模型直调同一工具）的审批 MUST 不受影响。本次调用的宿主上下文与调用方中止信号 MUST 传递给工具。工具结果的 `structuredResult.ok === true` 时，调用 MUST 在脚本内 resolve 为该结果的 `value`（解包后的结构化数据）；`ok === false` 时 MUST 在脚本内以 `CallFailedError` 失败，其 message 取自该结果的 `error`。调用失败 MUST 统一是 `CallFailedError`：工具抛出的异常、参数校验失败、结构化失败、工具名不可调用都走同一类型，脚本据此把「工具失败」与自身的运行期错误区分开。脚本可以选择捕获后继续执行。`structuredResult` MUST NOT 改变工具面向模型的文本输出、既有 `details` 或 `isError` 语义。

#### Scenario: 写类工具照常弹审批

- **WHEN** 模型直接调用一个需要授权的写类工具（写工作区外的 `Edit` / `Write`，不经 codemode）
- **THEN** 该工具自己的审批界面照常出现，用户的选择决定本次调用成功还是失败

#### Scenario: 需要授权的调用直接失败

- **WHEN** 脚本发起一个需要人工授权的调用（例如 `fs.write` 写工作区外、`Bash` 申请沙箱外执行）
- **THEN** 该调用在脚本内以 `CallFailedError` 失败，错误信息说明需要授权，不出现审批界面，也不产生任何副作用

#### Scenario: 结构化成功结果解包给脚本

- **WHEN** 脚本调用一个结果的 `structuredResult.ok === true` 的工具
- **THEN** 调用 resolve 为该结果的 `value`，脚本可以直接读取字段而不必解析文本

#### Scenario: 结构化失败结果让调用失败

- **WHEN** 脚本调用一个结果的 `structuredResult.ok === false` 的工具
- **THEN** 调用在脚本内以 `CallFailedError` reject，message 取自该结果的 `error`

#### Scenario: 工具失败在脚本内可捕获

- **WHEN** 脚本调用的工具抛出异常或参数校验失败
- **THEN** 该调用在脚本内以 `CallFailedError` reject，脚本捕获后可以继续执行

#### Scenario: 不额外增加确认

- **WHEN** 脚本连续发起多次写类调用，且这些工具自身不需要审批
- **THEN** codemode 不弹出任何额外确认，直接执行

### Requirement: 中止

脚本执行 MUST 只受调用方中止信号与脚本声明的执行预算（见「执行超时」）约束。中止时 MUST 立即终止执行该脚本的 worker 线程，且 MUST NOT 留下仍在运行的线程或进程；正在执行的嵌套调用 MUST 一并被中止。脚本等待嵌套调用返回的时长 MUST 计入执行预算（嵌套调用不再需要人工审批，见「嵌套调用的执行」）。

#### Scenario: 中止终止

- **WHEN** 调用方中止本次工具调用
- **THEN** 该 worker 被终止，工具结果以中止结束

#### Scenario: 等用户确认多久都不算失败

- **WHEN** 脚本等待一个很慢的嵌套调用返回（codemode 内不再有需要用户确认的调用，见「嵌套调用的执行」）
- **THEN** 未声明 `timeout_ms` 时等待多久都照常返回结果；声明了预算则该等待计入预算

#### Scenario: 无残留

- **WHEN** 脚本以任何方式结束（成功、失败、中止、超时）
- **THEN** 该次执行的 worker 线程结束

### Requirement: 执行超时

脚本 MAY 用首行的 `// @options: {"timeout_ms": …}` 声明本次执行的墙钟预算，该预算 MUST 包含等待嵌套调用的时间；未声明时 MUST 不施加任何时间上限。预算到点时 MUST 先确定结果再收尾：工具结果 MUST 是以超时为原因的失败，已产生的输出与完整调用记录 MUST 仍然可见；正在执行的嵌套调用 MUST 被中止；执行该脚本的 worker MUST 被终止。预算 MUST 覆盖无法自行交出控制权的脚本（忙循环）。

#### Scenario: 预算到点

- **WHEN** 脚本声明了 `timeout_ms` 且超过该时长仍未结束
- **THEN** 工具以失败结果返回（原因为超时），已产生的输出与调用记录仍然可见，worker 被终止

#### Scenario: 忙循环也被超时终止

- **WHEN** 脚本在 VM 里忙循环，且声明了 `timeout_ms`
- **THEN** 到点后该次执行结束，会话不受影响

#### Scenario: 等嵌套调用也计入预算

- **WHEN** 脚本声明了 `timeout_ms`，并在等待一个嵌套调用时超过该时长
- **THEN** 该嵌套调用被中止，执行以超时结束

#### Scenario: 未声明预算不设限

- **WHEN** 脚本没有声明 `timeout_ms` 且长时间运行
- **THEN** 不因时间原因被结束，只能由调用方中止（见「中止」）

### Requirement: 脚本接口

脚本 MUST 提供：`call(name, args)`（按工具名调用，返回 promise）、`CallFailedError`（工具调用失败的错误类型，脚本可按 `instanceof` 判别）、`ALL_TOOLS`、`text(value)`、`image(value)`、`exit()`、`sleep(seconds)`、`console.*`、`store.set(key, value)`、`store.get(key)`、`store.list()`，MUST 支持顶层 `await` 与 `return`，首行 MAY 为 `// @options:` 行（`max_output_tokens`、`timeout_ms`；未知字段 MUST 报错）。脚本 MUST NOT 能访问 `tools` 对象或任何按属性名分发的调用入口。脚本未调用任何工具却停在一个永远不会 settle 的 promise 上时 MUST 立刻失败，而不是挂住。

`sleep(seconds)` 是脚本唯一的等待手段：参数是秒、MAY 是小数，脚本 MUST 在指定秒数之后继续执行；它 MUST NOT 产生输出、MUST NOT 产生 toolcall 进度、也 MUST NOT 有上限（睡多久由脚本决定，结束只能靠调用方中止或执行预算）。沙箱里其余 timer（`setTimeout` / `setInterval`）MUST 仍然不存在。参数不是非负有限数时 MUST 以 `TypeError` 失败，且不是 `CallFailedError`。

`store` 是持久的键值表：`store.set(key, value)` 写入一个 JSON 可序列化的值，`store.set(key, undefined)` MUST 删除该键；`store.get(key)` MUST 返回该值（未命中返回 `undefined`）；`store.list()` MUST 返回当前所有键（升序）。

#### Scenario: 输出与返回值

- **WHEN** 脚本同时使用 `text()` 与 `return`
- **THEN** 工具输出包含脚本追加的文本与返回值的文本表示

#### Scenario: 按秒等待

- **WHEN** 脚本 `await sleep(0.05)` 后再 `text("done")`
- **THEN** 脚本等待该时长后继续执行，输出里只有 `done`（等待本身不产生任何输出与进度）

#### Scenario: sleep 的非法参数

- **WHEN** 脚本 `await sleep(-1)`、`await sleep(Number.NaN)` 或 `await sleep("2")`
- **THEN** 该调用抛 `TypeError`（脚本可捕获），不是 `CallFailedError`，也不执行等待

#### Scenario: 非法的 timeout_ms

- **WHEN** `// @options: {"timeout_ms": 0}`、负数、非整数或超过 2147483647
- **THEN** 工具以失败结果返回解析错误，不执行脚本

#### Scenario: 按名字调用工具

- **WHEN** 脚本 `call("Read", { file_path })` 调用一个可调用集合内的工具
- **THEN** 该工具被执行，结果按该工具的返回语义交给脚本

#### Scenario: 调用未知工具名

- **WHEN** 脚本 `call("NoSuchTool", {})`
- **THEN** 该调用在脚本内以 `CallFailedError` 失败，不产生任何宿主副作用

#### Scenario: store 跨调用保留

- **WHEN** 一次脚本 `store.set` 一个值，之后另一次脚本 `store.get` 同一个 key
- **THEN** 第二次脚本读到第一次写入的值，且失败脚本的写入不被保留

#### Scenario: store 随工具结果持久化

- **WHEN** 一次成功的 codemode 调用写入了 store
- **THEN** 该次写入出现在这次工具结果的 `details.store` 上，下一次调用从当前分支上 codemode 的 toolResult 条目重放恢复

#### Scenario: list 列出当前键

- **WHEN** 脚本写入若干键（其中一些被 `store.set(key, undefined)` 删除）后调用 `store.list()`
- **THEN** 返回仍然存在的键，升序排列，被删除的键不出现

#### Scenario: 永不 settle 的 promise

- **WHEN** 脚本 `await new Promise(() => {})`
- **THEN** 脚本立刻以错误结束，不挂住会话

#### Scenario: 非法 options

- **WHEN** `// @options:` 行不是合法 JSON 对象或含未知字段
- **THEN** 工具以失败结果返回解析错误，不执行脚本

### Requirement: 结果语义与输出预算

脚本抛错或解析失败 MUST 作为工具结果失败返回（`isError`），MUST NOT 让工具调用本身抛错，且失败结果 MUST 保留脚本已产生的输出。输出超过 `max_output_tokens`（缺省 10000）时 MUST 头尾截断并把完整文本写入临时文件，结果里 MUST 给出行数、截断量与文件路径。工具结果的 `details` MUST 记录脚本内每次嵌套调用的名字、状态与耗时。

#### Scenario: 脚本失败不抛错

- **WHEN** 脚本语法错误或在运行中抛异常
- **THEN** 工具返回失败结果，包含错误信息与已产生的输出

#### Scenario: 输出超预算

- **WHEN** 脚本输出的文本超过 `max_output_tokens`
- **THEN** 结果里给出截断后的头尾、截断量与完整输出的临时文件路径

#### Scenario: 调用记录

- **WHEN** 脚本调用若干工具后结束
- **THEN** 工具结果的 `details` 里能看到每次调用的名字、状态与耗时

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

### Requirement: 脚本文件原语

脚本 MUST 提供 `fs` 对象，含 `read(path)` 与 `write(path, content)` 两个方法，由宿主用 `node:fs/promises` 直接实现。`fs` MUST NOT 是工具：它 MUST NOT 出现在工具列表、`ALL_TOOLS` 或工具描述的工具重载里，也 MUST NOT 参与 `disabledTools` 与当前 active 工具的求交。相对路径 MUST 相对本次调用的 cwd 解析。两个方法的失败 MUST 在脚本内以 `CallFailedError` reject（与嵌套调用同一条失败通道），message MUST 保留底层错误说明。

`fs.read` MUST 返回文件全文的 UTF-8 文本，MUST NOT 加行号、MUST NOT 截断、MUST NOT 按大小设限（读到的内容不进模型上下文，放不下时以错误失败即可）；内容不是合法 UTF-8 时 MUST 以错误失败，MUST NOT 静默替换。读取成功 MUST 记入已读记账。

`fs.write` MUST 只接受字符串内容、MUST 创建缺失的父目录。写入前 MUST 要求目标文件处于「已读且读后未变」状态（复用 `src/lib/file-reads.ts` 的记账，且与文件工具共用同一份 state：任一侧读过的文件另一侧都算已读），未读或读后内容被改 MUST 以错误失败；目标文件不存在时 MUST 允许直接写入。写入前的路径检查 MUST 复用 write-guard 的边界判定：工作区内与 `/tmp` 自动放行；工作区外的写入 MUST 在脚本内以 `CallFailedError` 直接失败，message MUST 说明需要授权并建议改为直接调用写类工具，MUST NOT 弹出审批框，MUST NOT 产生任何副作用；headless 会话、Windows 与 `/bwrap-deny-request` 生效时同样直接拒绝。写入成功后 MUST 把新内容记成已读，且脚本产生的已读 MUST 随 codemode 的工具结果持久化，使其在分支重放后仍然有效。

`fs` 的声明 MUST 渲染进 codemode 的工具描述，使模型在写脚本前能看到这两个方法。

#### Scenario: 读到原始内容

- **WHEN** 脚本 `await fs.read(path)` 读一个文本文件
- **THEN** 得到文件全文，没有行号前缀、没有被截断

#### Scenario: 相对路径按 cwd 解析

- **WHEN** 脚本用相对路径调用 `fs.read` / `fs.write`
- **THEN** 路径相对本次调用的 cwd 解析

#### Scenario: 大文件不截断

- **WHEN** 脚本 `fs.read` 一个体积远大于「模型能看的内容」的文件（例如几十 MiB）
- **THEN** 得到完整内容，不按大小裁剪；只有真的放不下（VM 堆不够）时才以错误失败

#### Scenario: 非 UTF-8 内容报错

- **WHEN** 脚本 `fs.read` 一个不是合法 UTF-8 的文件
- **THEN** 调用以错误失败

#### Scenario: 未读就写被拒

- **WHEN** 脚本对一个已存在但本次会话没有读过的文件调用 `fs.write`
- **THEN** 调用以错误失败，提示需要先读，文件 MUST NOT 被修改

#### Scenario: 读后文件被改动再写被拒

- **WHEN** 脚本 `fs.read` 之后文件被外部改动，脚本再对同一路径 `fs.write`
- **THEN** 调用以错误失败，提示文件已被修改、需要重读，文件 MUST NOT 被覆盖

#### Scenario: 新建文件无需先读

- **WHEN** 脚本 `fs.write` 一个不存在的路径
- **THEN** 文件被创建，缺失的父目录一并创建，不要求先读

#### Scenario: 工作区外写入直接失败

- **WHEN** 脚本 `fs.write` 一个工作区外的路径
- **THEN** 调用在脚本内以 `CallFailedError` 失败，错误信息说明需要授权并建议直接调用写类工具；不弹审批，文件不变

#### Scenario: 受策略与平台约束

- **WHEN** headless 会话、Windows 或 `/bwrap-deny-request` 生效时脚本 `fs.write` 一个工作区外的路径
- **THEN** 调用被直接拒绝，不弹审批、不写文件

#### Scenario: 脚本读与工具读互通

- **WHEN** 文件由 `Read` 工具读过（或由 `fs.read` 读过），随后任一侧对同一文件写入
- **THEN** 两侧共用同一份已读记账：`fs.write` 认工具的读，写类工具也认脚本的读，不需要重新读一遍

#### Scenario: 出现在工具描述里

- **WHEN** 读取 codemode 的工具描述
- **THEN** 描述里有 `fs.read` / `fs.write` 的声明，且 `ALL_TOOLS` 与工具重载列表里没有它们

## Implementation

- **store 容量**：`store.set` 单个值的 JSON 序列化上限 256 KiB，整表上限 1 MiB；超限抛 `RangeError`，不写入。
- **VM 限制**：worker 里的 QuickJS 运行时堆上限 2 GiB，并设置 `maxStackSize` 把深递归变成脚本可捕获的 `RangeError`；不设置 `timeout_ms` 时脚本只受调用方中止约束。
- **worker 产物**：`src/codemode/worker.js` 由 esbuild 打包为自包含单文件（`quickjs-wasi` 外部化），由 `new Worker(url)` 直接加载。
