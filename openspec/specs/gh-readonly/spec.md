# gh-readonly Specification

## Purpose

GitHub 只读工具集：以系统 `gh` CLI 为后端查询 issue / PR / CI / release / 仓库信息，只读不产生任何写入；`gh` 缺失或 Windows 平台时不注册工具（而非工具调用失败）。

## Requirements

### Requirement: 工具注册门控

工具集仅在环境可用时注册。

#### Scenario: gh 缺失不注册

- **WHEN** PATH 中找不到 `gh`
- **THEN** 不注册任何工具，session 开始时 notify error

#### Scenario: Windows 不注册

- **WHEN** 运行在 Windows
- **THEN** 不注册任何工具，notify warning

### Requirement: 输出统一截断

所有工具输出统一截断，details 标注截断状态。

#### Scenario: 超限截断

- **WHEN** 命令输出超过 2000 行或 50KB
- **THEN** 输出截断，details 带 `truncated` 标志

### Requirement: 命令失败契约

非零退出以带上下文的错误报告，被终止的进程不表现为成功。

#### Scenario: 非零退出报错

- **WHEN** `gh` 命令非零退出
- **THEN** 抛出带完整调用输入与输出上下文的错误

#### Scenario: 超时/中止标注

- **WHEN** 命令超时（默认 10 分钟）或被中止
- **THEN** 错误标注 `(command timed out)` / `(command aborted)`；先 SIGTERM、5 秒后 SIGKILL，被 kill 的进程退出码记为失败而非成功

### Requirement: issue 与 PR 查询

查询 issue / PR 详情与列表。

#### Scenario: 按编号查询详情

- **WHEN** 指定 repo 与编号查询 issue 或 PR
- **THEN** 返回结构化详情（标题、状态、正文、作者、时间、labels、assignees、comments 等；PR 含变更统计与 reviews）

#### Scenario: 列表与跨仓库搜索

- **WHEN** 指定 repo 列出 issue / PR（支持 state / label / author / assignee / milestone / limit 过滤）
- **THEN** 返回列表；未指定 repo 且带关键词时退化为跨 GitHub 搜索（不拼接 `repo:` 限定符，避免 gh 误解析）

### Requirement: CI 日志读取

读取 workflow run 与 job 日志。

#### Scenario: 按需展开日志

- **WHEN** 读取 CI 日志
- **THEN** 默认只展开失败 step 的日志，step 可指定名称（不区分大小写）或 job id；`full=true` 返回完整输出，`output_file` 写文件并返回元数据

#### Scenario: 日志缓存

- **WHEN** 重复读取同一 runId:jobId 的日志
- **THEN** 命中磁盘缓存（`~/.cache/pi/ci-logs/`），同一 job 的请求串行化

### Requirement: 状态快照与阻塞等待

状态检查与阻塞等待工具分工明确。

#### Scenario: 状态快照

- **WHEN** 调用 `read-github-pr-status`
- **THEN** 返回当前 checks 快照不等待；退出码 0（全过）/ 1（有失败）/ 8（有 pending）均为合法状态

#### Scenario: 阻塞等待

- **WHEN** 调用 `wait-github-pr-checks` 或 `watch-github-run`
- **THEN** 阻塞等待完成（600 秒超时）；watch 结束后用 API 核验实际结果，不信 gh 退出码

## Implementation

所有工具经 `src/gh-readonly.ts` 的 `runGh` 封装：`spawn("gh", args, { shell: false })`，env 注入 `GH_PAGER=cat`，默认超时 10 分钟，超时 / 中止先 SIGTERM、5 秒后 SIGKILL。

- **注册门控**：Windows 或 PATH 无 `gh` 时不注册工具（notify warning / error）。
- **输出截断**：stdout 统一截断为 2000 行 / 50KB，details 带 `truncated` 标志。
- **错误契约**：非零退出抛 `GhError`，消息带调用输入与输出上下文，标注 `(command timed out)` / `(command aborted)` / `spawn failed`；被 kill 的进程退出码记为失败而非成功。
- **repo 缺省**：未指定 `repo` 时用当前目录解析（`gh repo view --json nameWithOwner`）。
- **CI 日志**：`read-github-ci-logs` 基于 `##[group]Run <name>` 深度 1 锚点解析 step（复合 action 内部 step 被吸收），清洗时间戳 / ANSI / group 标记；日志按 runId:jobId 磁盘缓存到 `~/.cache/pi/ci-logs/`，同一 job 的请求经 `createSeqState` 串行化。
- **等待工具**：`wait-github-pr-checks`（`gh pr checks --watch`，600s 超时）watch 退出后用 API 核验实际结论（`pr view --json headRefOid` → `actions/runs` → jobs），不信 gh 退出码。
- 无重试逻辑；`read-github-pr-comments` 的 `reviews=true` 并行调 `gh api` 拿 reviews + comments。

涉及文件：`src/gh-readonly.ts`。
