# Spec Delta

## MODIFIED Requirements

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
