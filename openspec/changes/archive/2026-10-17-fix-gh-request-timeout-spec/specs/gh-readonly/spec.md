# Spec Delta

## MODIFIED Requirements

### Requirement: 命令失败契约

GitHub 请求失败（HTTP 非 2xx、网络错误、token 无效 / 过期）MUST 抛出带上下文的错误：HTTP 状态、GitHub 的 message；搜索请求带触发请求的参数。认证失败（401）MUST 丢缓存 token 重试一次，仍失败才报错。调用方中止 MUST 通过 `signal` 传给请求，被中止的请求 MUST 记为失败而不是成功。

取数据路径 MUST NOT 再依赖 `gh` 的退出码与 stderr 文本构造错误；`gh` 子进程只剩「当前仓库」解析与 token 获取两处：前者失败抛 `GhError`（argv + 输出上下文），后者失败抛带 stderr 的普通 `Error` 并提示 `gh auth login`。REST 请求 MUST NOT 设应用层超时：长任务由调用方用 `signal` 取消（等待类工具另有自己的轮询上限），`gh` 子进程的默认超时只覆盖 repo 解析与 token 获取。

#### Scenario: REST 请求失败报错

- **WHEN** 一次 GitHub 请求返回错误状态（例如 404 / 403 / 500）
- **THEN** 抛出 `GithubApiError`，带 HTTP 状态与 GitHub 的 message；搜索分支额外带触发该请求的工具参数，`status` 为 404 时调用方可用 `isNotFound` 区分「不存在」与真失败

#### Scenario: gh 子进程失败报错

- **WHEN** `gh repo view` 非零退出
- **THEN** 抛出带完整调用输入与输出上下文的 `GhError`
- **WHEN** `gh auth token` 非零退出
- **THEN** 抛出带 stderr 的普通 `Error`，提示先执行 `gh auth login`

#### Scenario: 超时/中止标注

- **WHEN** 调用方中止（Esc），或 `gh` 子进程超过预算（默认 10 分钟，`auth token` 为 10 秒）
- **THEN** 该次调用以失败结束（不是把空结果当成成功）；REST 请求只由调用方中止信号取消，没有应用层请求超时；`gh` 子进程超时 / 中止先 SIGTERM、5 秒后 SIGKILL，被 kill 的进程退出码记为失败而非成功
