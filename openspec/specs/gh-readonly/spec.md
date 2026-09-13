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

`read-github-ci-logs` 按 job 下载日志：GitHub 只提供按 job id 取日志的端点，所以 `job` 必填（名称或 id），一次调用对应一个 job。工具不返回日志内容，也不做截断或清洗——它把日志原样落盘，并给出解析后的 steps 与每个 step 在文件中的行号范围，内容由模型自己读文件。

输出（`content` 里的 JSON 文本）：

```json
{
  "name": "lint",
  "id": 92374541920,
  "status": "completed",
  "conclusion": "failure",
  "log_file": "/home/user/.cache/pi/github/ci-logs/trim21/php-serialize/31026014828/92374541920.log",
  "steps": [
    {
      "number": 1,
      "name": "Set up job",
      "conclusion": "success",
      "start_line": 1,
      "end_line": 61
    },
    {
      "number": 7,
      "name": "Run npx tsc --pretty",
      "conclusion": "skipped"
    }
  ]
}
```

#### Scenario: 参数

- **WHEN** 调用 `read-github-ci-logs`
- **THEN** 接受 `run_id`（必填）、`repo`（可选，缺省用当前目录解析）、`job`（必填，job 名称或 id，取自 `list-github-workflow-runs` / `read-github-workflow-jobs`）；`job` 匹配不到时报错并列出该 run 的可用 `名称 (id)`

#### Scenario: 返回 steps 与原始日志文件

- **WHEN** 调用方给出一个已完成的 `job`
- **THEN** 返回上述 JSON：`log_file` 是该 job 的完整原始日志路径（保留 runner 时间戳与 ANSI，逐字节与 GitHub 交付的一致），`steps` 按 API 的 step 顺序列出 `number` / `name` / `conclusion`，并给出该 step 日志块在 `log_file` 中的 `start_line` / `end_line`（1-based，闭区间，可直接用于读取文件）

#### Scenario: 未运行的 step 没有行号

- **WHEN** 某个 step 被跳过、或它在日志里没有对应的块
- **THEN** 该 step 只带 `number` / `name` / `conclusion`，没有 `start_line` / `end_line`

#### Scenario: job 尚未开始

- **WHEN** `job` 处于 `queued` 状态
- **THEN** 不返回结构、不做无意义的抓取，提示日志尚未产生并指向 `watch-github-run`

#### Scenario: 日志缓存

- **WHEN** 重复读取同一 runId:jobId 的日志
- **THEN** 命中磁盘缓存（`~/.cache/pi/github/ci-logs/<owner>/<repo>/<runId>/<jobId>.log`），同一 job 的请求串行化

### Requirement: 状态快照与 run 级等待

状态检查与 run 级等待工具的分工：快照即返不等待，run 级等待阻塞到单个 workflow run 结束。PR checks 的阻塞等待独立成 spec（见 `openspec/specs/wait-github-pr-checks/`）。

#### Scenario: 状态快照

- **WHEN** 调用 `read-github-pr-status`
- **THEN** 返回当前 checks 快照不等待；退出码 0（全过）/ 1（有失败）/ 8（有 pending）均为合法状态

#### Scenario: run 级等待

- **WHEN** 调用 `watch-github-run`
- **THEN** 单次 `gh run watch` 阻塞至该 workflow run 结束并输出最终状态

## Implementation

所有工具经 `src/gh-readonly.ts` 的 `runGh` 封装：`spawn("gh", args, { shell: false })`，env 注入 `GH_PAGER=cat`，默认超时 10 分钟，超时 / 中止先 SIGTERM、5 秒后 SIGKILL。

- **注册门控**：Windows 或 PATH 无 `gh` 时不注册工具（notify warning / error）。
- **输出截断**：`gh` stdout 统一截断为 2000 行 / 50KB，details 带 `truncated` 标志（`read-github-ci-logs` 不再产出长文本，只返回 JSON 索引）。
- **错误契约**：非零退出抛 `GhError`，消息带调用输入与输出上下文，标注 `(command timed out)` / `(command aborted)` / `spawn failed`；被 kill 的进程退出码记为失败而非成功。
- **repo 缺省**：未指定 `repo` 时用当前目录解析（`gh repo view --json nameWithOwner`）。
- **CI 日志**：`read-github-ci-logs` 只取 `run_id` / `repo?` / `job`（必填）；job 列表走 `gh api .../actions/runs/<run_id>/jobs`，日志走 `gh api .../actions/jobs/<jobId>/logs`（GitHub 只有按 job id 取日志的端点，没有按 job 名称的），响应原样写入 `~/.cache/pi/github/ci-logs/<owner>/<repo>/<runId>/<jobId>.log`（`jobLogPath` 统一计算；owner/repo 由 `repoFromRunUrl` 解析 job 的 `run_url` 得出，用 GitHub 规范化后的仓库大小写，不受调用方传入的 `repo` 字符串影响），同一 job 的请求经 `createSeqState` 串行化。step 行号由 `stepLineSpans` 解析 `##[group]Run <name>` 深度 1 锚点得出（复合 action 的内部 step 归入外层 step 的区间），工具不清洗、不截断、不回显日志内容。
- **等待工具**：`wait-github-pr-checks` 的轮询、判定与报告见 `openspec/specs/wait-github-pr-checks/spec.md`（octokit 客户端在 `src/lib/github.ts`）；`watch-github-run` 仍为单次 `gh run watch`。
- 无重试逻辑；`read-github-pr-comments` 的 `reviews=true` 并行调 `gh api` 拿 reviews + comments。

涉及文件：`src/gh-readonly.ts`、`src/lib/github.ts`。
