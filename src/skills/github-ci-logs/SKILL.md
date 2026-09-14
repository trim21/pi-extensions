---
name: github-ci-logs
description: Use when 排查某个仓库的 CI 失败、要拿到具体 job 的日志 —— 从 repo + PR number / commit sha / branch name / tag 一路定位到 job 日志：read-github-pr-status 或 wait-github-commit-checks 找出失败的 check 及其 run_id/job_id，get-github-workflow-jobs 列某个 run 的全部 job，read-github-ci-logs 按 job_id 把原始日志落盘并按 step 行号读取。全程走工具，不需要手工跑 gh CLI。
---

# 从 PR / commit 定位到 CI 日志

## 核心原则

- **id 是唯一可靠的坐标**：日志工具只收 `job_id`，不接受 job 名称。名称 → id 必须先经过 check 列表或 job 列表工具。
- **不手工调 gh**：check / job / PR 数据都由工具封装好了 ，自己拼 `gh api` 只会重复劳动、还可能踩分页坑（jobs 端点默认一页 30 条）。
- **一次调用一个 job**：多个失败 job 就多次调用，逐个取。
- **日志内容不进上下文**：`read-github-ci-logs` 只返回索引（落盘路径 + 每个 step 的行号区间），内容自己用 Read 读区间、Grep 搜错误。

## 入口选择

| 手里有什么                    | 第一步                                                            | 拿到什么                                                                           |
| ----------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PR number                     | `read-github-pr-status { number, repo? }`                         | 该 PR head commit 的 checks 快照：`bucket` / `event` / `run_id` / `job_id` / `url` |
| commit sha / branch / tag     | `wait-github-commit-checks { commit, repo?, event? }`             | 已失败时立即返回；报告失败 job 的行带 `#<jobId>`                                   |
| 只有 repo（不知道是哪个 run） | `list-github-workflow-runs { repo?, workflow?, status?, limit? }` | run 列表（含 run id）                                                              |
| 只有 run_id                   | `get-github-workflow-jobs { run_id, repo? }`                      | 该 run 的全部 job：`id` / `name` / `status` / `conclusion` / `html_url` / `steps`  |

`repo` 都可省略，缺省用当前目录解析。

## 主流程

1. 用上表挑一个入口，拿到 checks 或 jobs 列表。
2. 找失败项：`bucket == "fail"`（PR 快照）或报告里 `(failure)` / `(timed_out)` / `(cancelled)` 的行。
3. 有 `job_id` 就直接进第 4 步。只有 `run_id`、或者想看看同一个 run 里还有哪些 job，就先 `get-github-workflow-jobs { run_id }`，按 `name` / `status` 挑出目标 job 的 `id`。
4. `read-github-ci-logs { job_id, repo? }` → JSON 索引：

   ```json
   {
     "name": "lint",
     "id": 92374541920,
     "status": "completed",
     "conclusion": "failure",
     "log_file": "/home/me/.cache/pi/github/ci-logs/a/b/42/92374541920.log",
     "steps": [
       {
         "number": 6,
         "name": "Run npx prettier --check ./",
         "conclusion": "failure",
         "start_line": 120,
         "end_line": 148
       }
     ]
   }
   ```

5. 读日志：优先读失败 step 的 `[start_line, end_line]`；要检索关键词（`##[error]`、`error:`、报错文件名）就在 `log_file` 上 Grep。`steps` 里没有行号的 step 是跳过或没产生日志的。
6. 还有别的失败 job → 回到第 4 步（用各自 job id）。

## 输出与边界

- `read-github-pr-status`：**立即返回快照，不轮询**。字段：`checks[].{name,bucket,event,run_id,job_id,url}`，非 Actions 的 check（Azure DevOps 等）`run_id`/`job_id` 为 null —— 这类没有 GitHub 侧 job 日志可读。
- `wait-github-commit-checks`：用于「没有 PR、只有 sha/branch/tag」的入口。它等的是 checks 全部结束，但**已经失败的 check 会让它第一轮就返回**；失败报告里的 Actions job 行带 `#jobId`。要更快返回可传 `fail_fast: true`；只想看某个事件的 check 用 `event`（如 `push`）。
- `get-github-workflow-jobs`：SDK 分页，一个 run 有 72 个 job 也会全部返回（旧版只返回前 30 个，第 31 个之后既列不出也选不中）。
- `read-github-ci-logs`：job 还在 `queued` 时不出日志，提示用 `watch-github-run` 等它开始；日志原样落盘到 `~/.cache/pi/github/ci-logs/<owner>/<repo>/<run_id>/<job_id>.log`（保留 runner 时间戳与 ANSI），同一 job 重复调用命中缓存，不重复下载。
- 工具**不做**日志截断、清洗或回显；拿到的是文件路径 + 行号，正文自己读。

## 与相邻工具的分工

- `read-github-pr-status`（快照即返）vs `wait-github-pr-checks`（阻塞轮询到检查结束）：前者用来定位，后者用来等结果。
- `watch-github-run`：已知 run_id、要等这个 run 跑完时用。
- `list-github-workflow-runs`：run 列表走 `gh run list`，适合「某个 workflow 最近一次跑得怎么样」这类不需要 PR 上下文的场景。

## 反例

- 用 job 名称去调 `read-github-ci-logs` —— 它只认 id，名称先经 `get-github-workflow-jobs` 转成 id。
- 为了拿日志去 Bash 跑 `gh api /repos/.../actions/runs/<id>/jobs` —— 直接用 `get-github-workflow-jobs`，分页与 id 提取已经处理好。
- 把整份日志读进上下文 —— 先用索引里的行号区间，或对 `log_file` 做 Grep。
