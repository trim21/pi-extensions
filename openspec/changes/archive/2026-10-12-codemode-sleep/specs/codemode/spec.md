# Spec Delta

## MODIFIED Requirements

### Requirement: 脚本接口

脚本 MUST 提供：`call(name, args)`（按工具名调用，返回 promise）、`CallFailedError`（工具调用失败的错误类型，脚本可按 `instanceof` 判别）、`ALL_TOOLS`、`text(value)`、`image(value)`、`exit()`、`sleep(seconds)`、`console.*`、`store.set(key, value)`、`store.get(key)`、`store.list()`，MUST 支持顶层 `await` 与 `return`，首行 MAY 为 `// @options:` 行（`max_output_tokens`；未知字段 MUST 报错）。脚本 MUST NOT 能访问 `tools` 对象或任何按属性名分发的调用入口。脚本未调用任何工具却停在一个永远不会 settle 的 promise 上时 MUST 立刻失败，而不是挂住。

`sleep(seconds)` 是脚本唯一的等待手段：参数是秒、MAY 是小数，脚本 MUST 在指定秒数之后继续执行；它 MUST NOT 产生输出、MUST NOT 产生 toolcall 进度、也 MUST NOT 有上限（睡多久由脚本决定，结束只能靠调用方中止）。沙箱里其余 timer（`setTimeout` / `setInterval`）MUST 仍然不存在。参数不是非负有限数时 MUST 以 `TypeError` 失败，且不是 `CallFailedError`。

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
