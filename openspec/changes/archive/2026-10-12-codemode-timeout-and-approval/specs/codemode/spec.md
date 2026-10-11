# Spec Delta

## MODIFIED Requirements

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

### Requirement: 嵌套调用的执行

脚本发起的每次嵌套调用 MUST 经本仓库工具总线的 `executeTool` 执行（参数校验与错误归一化由总线负责）。codemode 内 MUST NOT 出现任何审批：需要人工授权的嵌套调用（脚本 `fs.write` 写工作区外、`Bash` 申请沙箱外执行）MUST 在脚本内以 `CallFailedError` 直接失败，错误信息 MUST 说明该操作需要授权并建议改为直接调用该工具；这些调用 MUST NOT 产生宿主副作用。脚本之外的直接调用（模型直调同一工具）的审批 MUST 不受影响。本次调用的宿主上下文与调用方中止信号 MUST 传递给工具。工具结果的 `structuredResult.ok === true` 时，调用 MUST 在脚本内 resolve 为该结果的 `value`（解包后的结构化数据）；`ok === false` 时 MUST 在脚本内以 `CallFailedError` 失败，其 message 取自该结果的 `error`。结果不带 `structuredResult` 时 MUST resolve 为现有的文本（工具输出拍平）。调用失败 MUST 统一是 `CallFailedError`：工具抛出的异常、参数校验失败、结构化失败、工具名不可调用都走同一类型，脚本据此把「工具失败」与自身的运行期错误区分开。脚本可以选择捕获后继续执行。`structuredResult` MUST NOT 改变工具面向模型的文本输出、既有 `details` 或 `isError` 语义。

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

## ADDED Requirements

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
