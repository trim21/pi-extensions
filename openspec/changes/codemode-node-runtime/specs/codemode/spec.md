# Spec Delta

## MODIFIED Requirements

### Requirement: 脚本执行隔离

脚本 MUST 在本扩展启动的独立 Node 子进程里执行，MUST NOT 在 pi 进程内求值。该子进程 MUST 运行在本仓库 Bash 沙箱的同一份沙箱配置下（fs 模式、可写路径、只读保护、network 模式），因此脚本能读什么、能写什么、能否出网 MUST 与同一配置下沙箱里的 Bash 完全一致，MUST NOT 有第二套策略。bwrap 不可用（非 Linux、或用户命名空间被禁）时 MUST NOT 静默地以完整宿主权限执行：MUST 先经请求策略取得用户授权，headless 会话、Windows 或 `/bwrap-deny-request` 生效时 MUST 直接拒绝，并在工具结果里说明原因。每次执行 MUST 使用新的子进程，结束时 MUST 回收它连同它的进程组。只有脚本的输出与返回值进入模型上下文，脚本内部发起的工具调用 MUST NOT 在会话记录里产生工具调用条目。

#### Scenario: 读写与出网边界跟沙箱里的 Bash 一致

- **WHEN** 沙箱配置为「工作区可写 + 网络拒绝」，脚本读工作区外的文件、写工作区外的文件、并尝试出网
- **THEN** 读按沙箱的只读挂载成功，写与出网被沙箱直接拒绝（不经过审批弹窗），与同一配置下 Bash 的行为一致

#### Scenario: 沙箱配置只读时脚本也不能写

- **WHEN** 沙箱配置为只读，脚本写工作区内的文件
- **THEN** 写入被沙箱拒绝，脚本以错误结束

#### Scenario: 没有 bwrap 时要授权

- **WHEN** 运行环境没有可用的 bwrap
- **THEN** 执行前先向用户请求授权，用户拒绝时脚本不执行并返回说明原因的失败结果

#### Scenario: 平台与策略阻止无沙箱执行

- **WHEN** headless 会话、Windows 或 `/bwrap-deny-request` 生效，且运行环境没有可用的 bwrap
- **THEN** 脚本 MUST NOT 执行，结果 MUST 说明原因

#### Scenario: 脚本无法触达宿主能力

- **WHEN** 脚本尝试使用沙箱边界之外的能力：写不可写的路径、访问被拒绝的网络、或做任何宿主才能做的事
- **THEN** 这些操作在子进程里被沙箱直接拒绝并返回错误，MUST NOT 产生宿主侧副作用

#### Scenario: 嵌套调用结果不进入上下文

- **WHEN** 脚本调用若干工具并只输出其中一部分
- **THEN** 模型只收到脚本输出的内容，未输出的调用结果不出现，会话记录里也没有这些调用

#### Scenario: 死循环脚本不阻塞会话

- **WHEN** 脚本死循环
- **THEN** 会话继续正常工作，调用方中止后该子进程被终止

### Requirement: 嵌套调用的执行

脚本发起的每次嵌套调用 MUST 经本仓库工具总线的 `executeTool` 执行（参数校验与错误归一化由总线负责），因此工具实现内部的审批 MUST 照常生效；`codemode` MUST NOT 在工具自身审批之外再加确认层。嵌套调用 MUST 在 pi 进程内执行，MUST NOT 在脚本的沙箱里执行：脚本的沙箱只约束脚本自己直接做的事，每次嵌套调用的边界 MUST 由该工具自己的沙箱与审批决定（例如 `Bash` 请求沙箱外执行时照常走请求策略与用户审批），脚本的沙箱模式 MUST NOT 被当作嵌套工具的限制。本次调用的宿主上下文与调用方中止信号 MUST 传递给工具。工具结果的 `structuredResult.ok === true` 时，调用 MUST 在脚本内 resolve 为该结果的 `value`（解包后的结构化数据）；`ok === false` 时 MUST 在脚本内以 `CallFailedError` 失败，其 message 取自该结果的 `error`。结果不带 `structuredResult` 时 MUST resolve 为现有的文本（工具输出拍平）。调用失败 MUST 统一是 `CallFailedError`：工具抛出的异常、参数校验失败、结构化失败、工具名不可调用都走同一类型，脚本据此把「工具失败」与自身的运行期错误区分开。脚本可以选择捕获后继续执行。`structuredResult` MUST NOT 改变工具面向模型的文本输出、既有 `details` 或 `isError` 语义。

#### Scenario: 嵌套调用按工具自己的边界执行

- **WHEN** 脚本自身跑在一个只读沙箱里，脚本调用 `Bash`（带或不带沙箱外执行请求）
- **THEN** 该调用在 pi 进程内按 `Bash` 自己的沙箱配置与审批执行：脚本的沙箱既不阻止它，也不放大它的权限

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

脚本没有整体超时：脚本执行 MUST 只受调用方中止信号的约束。中止时 MUST 终止执行该脚本的子进程（连同它的进程组），且 MUST NOT 留下仍在运行的子进程。脚本等待嵌套调用返回的时长 MUST NOT 受任何时限约束（其中包含用户确认写类调用、Bash 提权弹窗的等待）。

#### Scenario: 中止终止

- **WHEN** 调用方中止本次工具调用
- **THEN** 该子进程被终止，工具结果以中止结束

#### Scenario: 等用户确认多久都不算失败

- **WHEN** 脚本发起一个需要用户确认的嵌套调用，用户过了很久才确认
- **THEN** 该调用照常返回结果，脚本继续运行

#### Scenario: 无残留

- **WHEN** 脚本以任何方式结束（成功、失败、中止）
- **THEN** 该次执行的子进程及其进程组不再存在

### Requirement: 脚本接口

脚本 MUST 提供：`call(name, args)`（按工具名调用，返回 promise）、`CallFailedError`（调用失败的错误类型，脚本可按 `instanceof` 判别）、`ALL_TOOLS`、`text(value)`、`image(value)`、`exit()`、`console.*`、`store.set(key, value)`、`store.get(key)`、`store.list()`，MUST 支持顶层 `await` 与 `return`，首行 MAY 为 `// @options:` 行（`max_output_tokens`；未知字段 MUST 报错）。脚本 MUST NOT 能访问 `tools` 对象或任何按属性名分发的调用入口。

脚本在 Node 运行时里执行，因此 Node 内置模块与全局对象（文件系统、路径、进程、计时器等）MUST 直接可用，文件操作 MUST NOT 需要经工具转发；这些能力的实际边界由「脚本执行隔离」规定的沙箱决定。脚本的 `console` 输出与任何直接写入 stdout / stderr 的内容 MUST 都作为脚本输出进入工具结果，MUST NOT 破坏宿主与脚本之间的通信。脚本既没有发起嵌套调用、也没有任何挂起的定时器或 IO 等异步资源，却仍停在一个永远不会 settle 的 promise 上时 MUST 立刻失败，而不是挂住。

`store` 是持久的键值表：`store.set(key, value)` 写入一个 JSON 可序列化的值，`store.set(key, undefined)` MUST 删除该键；`store.get(key)` MUST 返回该值（未命中返回 `undefined`）；`store.list()` MUST 返回当前所有键（升序）。

#### Scenario: 输出与返回值

- **WHEN** 脚本同时使用 `text()` 与 `return`
- **THEN** 工具输出包含脚本追加的文本与返回值的文本表示

#### Scenario: 按名字调用工具

- **WHEN** 脚本 `call("Bash", { command })` 调用一个可调用集合内的工具
- **THEN** 该工具被执行，结果按该工具的返回语义交给脚本

#### Scenario: 调用未知工具名

- **WHEN** 脚本 `call("NoSuchTool", {})`
- **THEN** 该调用在脚本内以 `CallFailedError` 失败，不产生任何宿主副作用

#### Scenario: 直接用 Node 内置模块读写文件

- **WHEN** 脚本使用 Node 的文件系统模块读一个文件并把内容写回另一个文件
- **THEN** 读写按沙箱挂载生效，不经过工具总线，也不产生工具调用记录

#### Scenario: 脚本自己写 stdout 不影响协议

- **WHEN** 脚本（或它使用的库）向 stdout / stderr 写入任意内容，包括看起来像协议帧的文本
- **THEN** 这些内容只作为脚本输出出现，嵌套调用与返回值照常工作

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

## REMOVED Requirements

### Requirement: 脚本文件原语

**Reason**: 脚本现在跑在真 Node 运行时里，文件读写直接用 Node 内置的文件系统模块即可；宿主侧的 `fs.read` / `fs.write` 原语连同它的那套已读记账、与文件工具共用的记账互锁、以及经桥的写审批都被它取代，属于重复机制。沙箱挂载本身就限定了脚本能写什么（可写路径由沙箱配置决定），因此也不需要再叠一层审批。

**Migration**: 脚本里把 `fs.read(path)` 换成 Node 的读文件 API、`fs.write(path, content)` 换成 Node 的写文件 API（需要创建父目录时自行创建）。原本依赖「先读后写」保护与工作区外写审批的脚本行为改由沙箱边界保证：能写的路径写在沙箱配置里，写不出去的操作会直接失败而不是弹审批。需要审批的工作区外写入请用 `Write` 工具或 Bash，不在脚本里做。
