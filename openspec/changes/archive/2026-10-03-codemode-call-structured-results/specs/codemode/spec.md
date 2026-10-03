# Spec Delta

## MODIFIED Requirements

### Requirement: 工具注册与可调用工具集合

扩展 MUST 注册名为 `codemode` 的工具，并 MUST 在注册时把脚本可调用的工具集合渲染进工具描述，为每个工具给出名字、说明、参数类型与返回类型。返回类型 MUST 由工具声明的输出结构推导：声明了 `structuredSchema` 的工具按该 schema 渲染，未声明的工具渲染为文本（`string`）。该集合 MUST 等于本仓库工具总线上实际注册的工具减去 `codemode` 自身与 `spawn-agent`；执行时 MUST 再与当前 active 工具列表求交（取不到 active 列表时不过滤）。脚本 MUST NOT 能调用 `codemode` 自身，也 MUST NOT 能调用 `spawn-agent`。

#### Scenario: 描述列出可调用工具

- **WHEN** 获取 `codemode` 的工具描述
- **THEN** 描述包含总线上除 `codemode` 与 `spawn-agent` 外每个工具的名字、说明与参数类型声明

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
