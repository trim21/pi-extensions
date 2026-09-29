# Spec Delta

## Purpose

让模型用一段 JavaScript 编排本工具集的工具：脚本在受限的独立进程里执行，只有脚本输出进入模型上下文，脚本发起的每个写类调用都经用户逐次确认。

## ADDED Requirements

### Requirement: 工具注册与可调用工具集合

扩展 MUST 注册名为 `codemode` 的工具，并 MUST 在注册时把脚本可调用的工具集合写进工具描述，包含每个工具的名字、说明与参数类型声明。该集合 MUST 等于本仓库工具总线上实际注册的工具，MUST NOT 包含 `codemode` 自身；执行时 MUST 再按当前 active 工具列表过滤，未启用的工具（被 `personalExtensions` 规则禁用、被 pi 的 `defaultTools` 或 CLI `--tools` 排除、子代理工具白名单之外）在脚本内 MUST NOT 可调用。在同时提供内置 `codemode` 的 pi 版本上，注册同名工具后会话里 MUST 只存在一个 `codemode`。

#### Scenario: 描述列出可调用工具

- **WHEN** 获取 `codemode` 的工具描述
- **THEN** 描述包含总线上每个工具的名字、说明与参数类型声明

#### Scenario: 集合外的工具不可调用

- **WHEN** 脚本尝试调用不在总线上的任何工具
- **THEN** 该调用失败并返回错误，不产生任何宿主副作用

#### Scenario: 未启用的工具不可调用

- **WHEN** 脚本调用一个已注册但当前不 active 的工具（例如被子代理工具白名单排除）
- **THEN** 该调用失败并返回错误，不执行该工具

#### Scenario: 脚本自身不可再调用 codemode

- **WHEN** 脚本尝试调用 `codemode`
- **THEN** 该调用失败并返回错误，不会递归启动新的脚本

### Requirement: 脚本执行隔离

脚本 MUST 在独立于 pi 进程的进程中执行，该进程 MUST 不能读写 workspace 与 agent 目录、不能访问网络。只有脚本的输出与返回值进入模型上下文，脚本内部发起的工具调用结果 MUST NOT 直接进入上下文，也 MUST NOT 在会话记录里产生工具调用条目。沙箱不可用时 MUST 仍在独立进程中执行，并在工具结果中说明本次未隔离。

#### Scenario: 脚本无法触达工作区文件

- **WHEN** 脚本尝试读取工作区文件、读取 agent 目录下的凭据，或发起网络请求
- **THEN** 这些能力在脚本内不存在，操作失败且不产生任何宿主副作用

#### Scenario: 嵌套调用结果不进入上下文

- **WHEN** 脚本调用若干工具并只输出其中部分内容
- **THEN** 模型只收到脚本输出的内容，未输出的调用结果不出现，会话记录里也没有这些调用

#### Scenario: 沙箱不可用时的降级

- **WHEN** 宿主环境没有可用的沙箱能力
- **THEN** 脚本仍在独立进程中执行，工具结果中明确标注本次未隔离执行

### Requirement: 嵌套调用的执行与确认

脚本发起的每个嵌套调用 MUST 经本仓库工具总线的 `executeTool` 执行（参数校验与错误归一化由总线负责），因此工具内部的审批（工作区外写入审批、Bash 的提权审批等）MUST 照常生效。只读集合（`Read` / `Glob` / `Grep`，`fileIo` 为 `opencode` 时为 `read` / `glob` / `grep`）之外的调用 MUST 在每次执行前单独请求用户确认；用户拒绝时该调用 MUST 在脚本内以错误失败，脚本可选择继续。无 UI 的会话中，只读集合之外的调用 MUST 被拒绝而不是放行。

#### Scenario: 只读调用直接执行

- **WHEN** 脚本调用 `Read` / `Glob` / `Grep`
- **THEN** 调用直接执行并返回结果，不弹确认

#### Scenario: 写类调用逐次确认

- **WHEN** 脚本在同一个脚本里连续发起两次写类调用（例如两次 `Edit`）
- **THEN** 两次调用各自弹一次确认，任一次被拒绝只让该次调用失败，脚本继续执行

#### Scenario: 工具自身审批叠加

- **WHEN** 脚本调用写类工具写入工作区之外的路径
- **THEN** 除本次调用的确认外，工具自身的写入审批同样生效

#### Scenario: 无 UI 时拒绝

- **WHEN** 会话没有可用的确认界面且脚本发起只读集合之外的调用
- **THEN** 该调用被拒绝，脚本收到错误

### Requirement: 超时与中止

脚本执行 MUST 受 `// @options:` 中 `timeout_ms` 与调用方中止信号的约束。超时或中止时 MUST 终止脚本进程及其派生的整个进程树，不得残留子进程。

#### Scenario: 超时终止

- **WHEN** 脚本超过 `timeout_ms` 仍在运行（例如死循环）
- **THEN** 脚本被执行终止，工具结果失败并保留终止前已产生的输出

#### Scenario: 中止终止

- **WHEN** 调用方中止本次工具调用
- **THEN** 脚本进程被终止，工具结果以中止结束

#### Scenario: 无残留进程

- **WHEN** 脚本以任何方式结束（正常、失败、超时、中止）
- **THEN** 该次执行创建的进程全部退出，不留下仍在运行的子进程

### Requirement: 脚本接口与结果语义

脚本 MUST 提供与 pi codemode 一致的接口：`tools.<name>(args)` 返回 promise、`ALL_TOOLS` 列出可用工具、`text` / `image` 追加输出、`exit()` 提前结束、`console.*` 追加文本、`store` / `load` 跨调用保存 JSON 值、支持顶层 `await` 与 `return`、首行可选 `// @options:`（`max_output_tokens` 限制直接返回给模型的输出预算）。脚本抛错或解析失败 MUST 作为工具结果失败返回（保留部分输出），而不是让工具调用本身抛错。

#### Scenario: 输出与返回值

- **WHEN** 脚本同时使用 `text()` 与 `return` 产生输出
- **THEN** 工具输出包含脚本追加的文本项与返回值的文本表示，且返回值不被 `max_output_tokens` 之外的额外截断影响

#### Scenario: store 跨调用保留

- **WHEN** 一次脚本 `store` 一个值，之后另一次脚本 `load` 同一个 key
- **THEN** 第二次脚本读到第一次写入的值，且失败脚本的写入不被保留

#### Scenario: 脚本失败不抛错

- **WHEN** 脚本语法错误或在运行中抛异常
- **THEN** 工具返回失败结果并保留已产生的输出，错误信息含脚本内报错位置
