# Spec Delta

## Purpose

让模型用一段 JavaScript 编排本仓库的工具：脚本在没有宿主能力的 QuickJS VM 里执行，只有脚本的输出与返回值进入模型上下文，脚本发起的每次工具调用都与模型直接调用走同一套实现（含各自的审批）。

## ADDED Requirements

### Requirement: 工具注册与可调用工具集合

扩展 MUST 注册名为 `codemode` 的工具，并 MUST 在注册时把脚本可调用的工具集合渲染进工具描述（每个工具的名字、说明与参数类型声明）。该集合 MUST 等于本仓库工具总线上实际注册的工具减去 `codemode` 自身；执行时 MUST 再与当前 active 工具列表求交（取不到 active 列表时不过滤）。脚本 MUST NOT 能调用 `codemode` 自身。

#### Scenario: 描述列出可调用工具

- **WHEN** 获取 `codemode` 的工具描述
- **THEN** 描述包含总线上每个工具（`codemode` 除外）的名字、说明与参数类型声明

#### Scenario: 集合外的工具不可调用

- **WHEN** 脚本调用一个不在总线上的工具名
- **THEN** 该调用在脚本内以错误失败，不产生任何宿主副作用

#### Scenario: 未启用的工具不可调用

- **WHEN** 脚本调用一个已注册但当前不 active 的工具（例如子代理工具白名单之外的工具）
- **THEN** 该调用失败，不执行该工具

#### Scenario: 脚本自身不可再调用 codemode

- **WHEN** 脚本尝试调用 `codemode`
- **THEN** 该调用失败，不会递归启动新的脚本

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

脚本发起的每次嵌套调用 MUST 经本仓库工具总线的 `executeTool` 执行（参数校验与错误归一化由总线负责），因此工具实现内部的审批 MUST 照常生效；`codemode` MUST NOT 在工具自身审批之外再加确认层。本次调用的宿主上下文与调用方中止信号 MUST 传递给工具。工具失败（含参数校验失败）时 MUST 在脚本内以错误失败，脚本可以选择继续执行。

#### Scenario: 写类工具照常弹审批

- **WHEN** 脚本调用一个需要审批的工具（例如 `Bash` 的沙箱外执行、写工作区外文件的 `Edit`）
- **THEN** 该工具自己的审批界面照常出现，用户的选择决定本次调用成功还是失败

#### Scenario: 工具失败在脚本内可捕获

- **WHEN** 脚本调用的工具返回错误
- **THEN** 该调用在脚本内 reject，脚本捕获后可以继续执行

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

脚本 MUST 提供：`tools.<name>(args)`（返回 promise）、`ALL_TOOLS`、`text(value)`、`image(value)`、`exit()`、`console.*`、`store(key, value)`、`load(key)`，MUST 支持顶层 `await` 与 `return`，首行 MAY 为 `// @options:` 行（`max_output_tokens`；未知字段 MUST 报错）。脚本未调用任何工具却停在一个永远不会 settle 的 promise 上时 MUST 立刻失败，而不是挂住。

#### Scenario: 输出与返回值

- **WHEN** 脚本同时使用 `text()` 与 `return`
- **THEN** 工具输出包含脚本追加的文本与返回值的文本表示

#### Scenario: store 跨调用保留

- **WHEN** 一次脚本 `store` 一个值，之后另一次脚本 `load` 同一个 key
- **THEN** 第二次脚本读到第一次写入的值，且失败脚本的写入不被保留

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
