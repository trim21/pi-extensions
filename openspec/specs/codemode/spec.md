# codemode Specification

## Purpose

让模型用一段 JavaScript 编排本仓库的工具：脚本在没有宿主能力的 QuickJS VM 里执行，只有脚本的输出与返回值进入模型上下文，脚本发起的每次工具调用都与模型直接调用走同一套实现（含各自的审批）。

## Requirements

### Requirement: 工具注册与可调用工具集合

扩展 MUST 注册名为 `codemode` 的工具，并 MUST 在注册时把脚本可调用的工具集合渲染进工具描述，为每个工具给出名字、说明、参数类型与返回类型。返回类型 MUST 由工具声明的输出结构推导：声明了 `structuredSchema` 的工具按该 schema 渲染，未声明的工具渲染为文本（`string`）。该集合 MUST 等于本仓库工具总线上实际注册的工具减去排除名单，排除名单为 `codemode` 自身、`spawn-agent`、两套文件工具集的读写工具（`Read` / `Edit` / `Write` 与 `read` / `edit` / `write`），以及两套工具集的搜索工具（`Grep` / `Glob` 与 `grep` / `glob`）；执行时 MUST 再与当前 active 工具列表求交（取不到 active 列表时不过滤）。脚本 MUST NOT 能调用排除名单里的任何工具名。

搜索工具被排除是因为脚本有更好的选择：用 `call("Bash", { command })` 跑 `rg` / `grep`，走同一个沙箱、拿得到退出码与结构化输出（见 `Bash` 的结构化结果），能拼管道也少一大截参数与输出模式的声明。

#### Scenario: 描述列出可调用工具

- **WHEN** 获取 `codemode` 的工具描述
- **THEN** 描述包含总线上除排除名单外每个工具的名字、说明与参数类型声明

#### Scenario: 描述给出每个工具的返回类型

- **WHEN** 某工具声明了输出结构，另一个工具没有
- **THEN** 描述里前者的返回类型按该结构渲染，后者的返回类型为文本（`string`）

#### Scenario: 集合外的工具不可调用

- **WHEN** 脚本调用一个不在总线上的工具名
- **THEN** 该调用在脚本内以错误失败，不产生任何宿主副作用

#### Scenario: 未启用的工具不可调用

- **WHEN** 脚本调用一个已注册但当前不 active 的工具（例如子代理工具白名单之外的工具）
- **THEN** 该调用失败，不执行该工具

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
- **THEN** 该调用在脚本内以错误失败，工具 MUST NOT 被执行，`codemode` 的工具描述里也不出现它们的参数声明；脚本要搜文件用 `call("Bash", { command })` 跑 `rg`

#### Scenario: 脚本用 Bash 拿退出码与输出

- **WHEN** 脚本 `call("Bash", { command: "rg -q needle file" })`
- **THEN** 调用 resolve 为 `Bash` 的结构化结果（`{ exitCode, output }`），脚本据 `exitCode` 分支，命令本身的非零退出不是调用失败

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

脚本发起的每次嵌套调用 MUST 经本仓库工具总线的 `executeTool` 执行（参数校验与错误归一化由总线负责），因此工具实现内部的审批 MUST 照常生效；`codemode` MUST NOT 在工具自身审批之外再加确认层。本次调用的宿主上下文与调用方中止信号 MUST 传递给工具。工具结果的 `structuredResult.ok === true` 时，调用 MUST 在脚本内 resolve 为该结果的 `value`（解包后的结构化数据）；`ok === false` 时 MUST 在脚本内以 `CallFailedError` 失败，其 message 取自该结果的 `error`。结果不带 `structuredResult` 时 MUST resolve 为现有的文本（工具输出拍平）。调用失败 MUST 统一是 `CallFailedError`：工具抛出的异常、参数校验失败、结构化失败、工具名不可调用都走同一类型，脚本据此把「工具失败」与自身的运行期错误区分开。脚本可以选择捕获后继续执行。`structuredResult` MUST NOT 改变工具面向模型的文本输出、既有 `details` 或 `isError` 语义。

#### Scenario: 写类工具照常弹审批

- **WHEN** 脚本调用一个需要审批的工具（例如 `Bash` 的沙箱外执行、写工作区外文件的 `Edit`）
- **THEN** 该工具自己的审批界面照常出现，用户的选择决定本次调用成功还是失败

#### Scenario: 结构化成功结果解包给脚本

- **WHEN** 脚本调用一个结果的 `structuredResult.ok === true` 的工具
- **THEN** 调用 resolve 为该结果的 `value`，脚本可以直接读取字段而不必解析文本

#### Scenario: 结构化失败结果让调用失败

- **WHEN** 脚本调用一个结果的 `structuredResult.ok === false` 的工具
- **THEN** 调用在脚本内以 `CallFailedError` reject，message 取自该结果的 `error`

#### Scenario: 不带结构化结果的工具返回文本

- **WHEN** 脚本调用一个结果不带 `structuredResult` 的工具并成功
- **THEN** 调用 resolve 为该工具输出的文本

#### Scenario: 工具失败在脚本内可捕获

- **WHEN** 脚本调用的工具抛出异常或参数校验失败
- **THEN** 该调用在脚本内以 `CallFailedError` reject，脚本捕获后可以继续执行

#### Scenario: 不额外增加确认

- **WHEN** 脚本连续发起多次写类调用，且这些工具自身不需要审批
- **THEN** codemode 不弹出任何额外确认，直接执行

### Requirement: 中止

脚本没有整体超时：脚本执行 MUST 只受调用方中止信号的约束。中止时 MUST 终止执行该脚本的 worker 线程，且 MUST NOT 留下仍在运行的线程或进程。脚本等待嵌套调用返回的时长 MUST NOT 受任何时限约束（其中包含用户确认写类调用、Bash 提权弹窗的等待）。

#### Scenario: 中止终止

- **WHEN** 调用方中止本次工具调用
- **THEN** 该 worker 被终止，工具结果以中止结束

#### Scenario: 等用户确认多久都不算失败

- **WHEN** 脚本发起一个需要用户确认的嵌套调用，用户过了很久才确认
- **THEN** 该调用照常返回结果，脚本继续运行

#### Scenario: 无残留

- **WHEN** 脚本以任何方式结束（成功、失败、中止）
- **THEN** 该次执行的 worker 线程结束

### Requirement: 脚本接口

脚本 MUST 提供：`call(name, args)`（按工具名调用，返回 promise）、`CallFailedError`（工具调用失败的错误类型，脚本可按 `instanceof` 判别）、`ALL_TOOLS`、`text(value)`、`image(value)`、`exit()`、`console.*`、`store.set(key, value)`、`store.get(key)`、`store.list()`，MUST 支持顶层 `await` 与 `return`，首行 MAY 为 `// @options:` 行（`max_output_tokens`；未知字段 MUST 报错）。脚本 MUST NOT 能访问 `tools` 对象或任何按属性名分发的调用入口。脚本未调用任何工具却停在一个永远不会 settle 的 promise 上时 MUST 立刻失败，而不是挂住。

`store` 是持久的键值表：`store.set(key, value)` 写入一个 JSON 可序列化的值，`store.set(key, undefined)` MUST 删除该键；`store.get(key)` MUST 返回该值（未命中返回 `undefined`）；`store.list()` MUST 返回当前所有键（升序）。

#### Scenario: 输出与返回值

- **WHEN** 脚本同时使用 `text()` 与 `return`
- **THEN** 工具输出包含脚本追加的文本与返回值的文本表示

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

### Requirement: 脚本文件原语

脚本 MUST 提供 `fs` 对象，含 `read(path)` 与 `write(path, content)` 两个方法，由宿主用 `node:fs/promises` 直接实现。`fs` MUST NOT 是工具：它 MUST NOT 出现在工具列表、`ALL_TOOLS` 或工具描述的工具重载里，也 MUST NOT 参与 `disabledTools` 与当前 active 工具的求交。相对路径 MUST 相对本次调用的 cwd 解析。两个方法的失败 MUST 在脚本内以 `CallFailedError` reject（与嵌套调用同一条失败通道），message MUST 保留底层错误说明。

`fs.read` MUST 返回文件全文的 UTF-8 文本，MUST NOT 加行号、MUST NOT 截断、MUST NOT 按大小设限（读到的内容不进模型上下文，放不下时以错误失败即可）；内容不是合法 UTF-8 时 MUST 以错误失败，MUST NOT 静默替换。读取成功 MUST 记入已读记账。

`fs.write` MUST 只接受字符串内容、MUST 创建缺失的父目录。写入前 MUST 要求目标文件处于「已读且读后未变」状态（复用 `src/lib/file-reads.ts` 的记账，且与文件工具共用同一份 state：任一侧读过的文件另一侧都算已读），未读或读后内容被改 MUST 以错误失败；目标文件不存在时 MUST 允许直接写入。写入前的路径审批 MUST 复用 write-guard 的既有行为：工作区内与 `/tmp` 自动放行，工作区外弹审批并在预览里给出变更前后的 diff，headless 会话、Windows 与 `/bwrap-deny-request` 生效时 MUST 直接拒绝。写入成功后 MUST 把新内容记成已读，且脚本产生的已读 MUST 随 codemode 的工具结果持久化，使其在分支重放后仍然有效。

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

#### Scenario: 写入沿用 write-guard 审批

- **WHEN** 脚本 `fs.write` 一个工作区外的路径
- **THEN** 与写类工具一致地弹出审批（预览包含变更前后的 diff），用户不批准时调用失败且文件不变

#### Scenario: 受策略与平台约束

- **WHEN** headless 会话、Windows 或 `/bwrap-deny-request` 生效时脚本 `fs.write` 一个工作区外的路径
- **THEN** 调用被直接拒绝，不弹审批、不写文件

#### Scenario: 脚本读与工具读互通

- **WHEN** 文件由 `Read` 工具读过（或由 `fs.read` 读过），随后任一侧对同一文件写入
- **THEN** 两侧共用同一份已读记账：`fs.write` 认工具的读，写类工具也认脚本的读，不需要重新读一遍

#### Scenario: 出现在工具描述里

- **WHEN** 读取 codemode 的工具描述
- **THEN** 描述里有 `fs.read` / `fs.write` 的声明，且 `ALL_TOOLS` 与工具重载列表里没有它们
