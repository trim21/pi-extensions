---
name: github-ci-logs
description: Use when 排查某个仓库的 CI 失败、要拿到具体 job 的日志 —— gh 工具只经 codemode 调用：在脚本里 call("read-github-pr-status" / "wait-github-commit-checks" / "list-github-workflow-runs" / "get-github-workflow-jobs" / "read-github-ci-logs")，从 repo + PR number / commit sha / branch name / tag 一路定位到 log_file 与 step 行号区间。全程走工具，不需要手工跑 gh CLI。
---

# 从 PR / commit 定位到 CI 日志

## 核心原则

- **gh 工具只能在 codemode 脚本里调**：它们不交给模型（不在可见工具清单里），`call(name, args)` 的返回值就是结构化对象——REST 原物或从响应解析出的结构，没有文本输出。
- **id 是唯一可靠的坐标**：日志工具只收 `job_id`，不接受 job 名称。名称 → id 先经 check 列表或 job 列表。
- **不手工调 gh**：check / job / PR 数据都由工具封装好了，自己拼 `gh api` 只会重复劳动、还可能踩分页坑。
- **一次调用一个 job**：多个失败 job 就多次调用，逐个取。
- **日志正文不进上下文**：`read-github-ci-logs` 返回落盘路径与每个 step 的行号区间；正文用 `fs.read` 读区间，或把路径 `text()` 到上下文后用 Read / Grep 读文件。

## 入口选择

下表的第一步都在脚本里执行，例如：

```js
const snapshot = await call("read-github-pr-status", { number: 123, repo: "o/r" });
text(snapshot.checks.filter((check) => check.bucket === "fail"));
```

| 手里有什么                    | 第一步                                                                     | 拿到什么                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| PR number                     | `call("read-github-pr-status", { number, repo? })`                         | 该 PR head commit 的 checks 快照：`name` / `bucket` / `event` / `run_id` / `job_id` / `suite_id` / `url` |
| commit sha / branch / tag     | `call("wait-github-commit-checks", { commit, repo?, event? })`             | 已失败时立即返回；`status` / `checks` / `failedJobs`（失败 job 带 `jobId` / `jobUrl`）                   |
| 只有 repo（不知道是哪个 run） | `call("list-github-workflow-runs", { repo?, workflow?, status?, limit? })` | `runs` 列表（含 run `id`）                                                                               |
| 只有 run_id                   | `call("get-github-workflow-jobs", { run_id, repo? })`                      | 该 run 的全部 job：`id` / `name` / `status` / `conclusion` / `html_url` / `steps`                        |

`repo` 都可省略，缺省用当前目录解析。脚本里一次可以批量调多个（`Promise.all`），只把需要的字段 `text()` 出来。

## 主流程

1. 用上表挑一个入口，拿到 checks 或 jobs。
2. 找失败项：`bucket === "fail"`（checks 快照），或 `status === "failure"` 下的 `failedJobs`。
3. 有 `job_id` 就直接进第 4 步。只有 `run_id`、或想看看同一个 run 里还有哪些 job，就先 `call("get-github-workflow-jobs", { run_id })`，按 `name` / `status` / `conclusion` 挑出目标 job 的 `id`。
4. `call("read-github-ci-logs", { job_id, repo? })` → 结构化索引：

   ```js
   const index = await call("read-github-ci-logs", { job_id: 92374541920, repo: "o/r" });
   if (!index.ok) text(index.error);
   else text({ log_file: index.value.log_file, steps: index.value.steps });
   ```

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

5. 读日志：把失败 step 的 `[start_line, end_line]` 对应的行读出来。两种读法——
   - 脚本内：`fs.read(log_file)` 拿全文（不截断、不设上限），自己按行号切片后 `text()` 需要的部分；
   - 脚本外：`text(log_file)` 把路径输出到上下文，再用 Read 按 `offset` / `limit` 读区间、用 Grep 在文件上搜 `##[error]` 之类的关键词（大日志优先这种，避免整份日志进上下文）。
6. 还有别的失败 job → 回到第 4 步（用各自 job id）。

## 输出与边界

- `read-github-pr-status`：**立即返回快照，不轮询**。字段：`checks[].{name,bucket,event,run_id,job_id,suite_id,url}`，非 Actions 的 check（Azure DevOps 等）`run_id`/`job_id` 为 null —— 这类没有 GitHub 侧 job 日志可读。`bucket === "action_required"` 表示该 workflow 在等维护者批准（fork PR 的首次运行），它还没有 job、没有日志可读，条目来自 check suite 并按对应的 workflow run 命名。
- `wait-github-commit-checks`：用于「没有 PR、只有 sha/branch/tag」的入口。它等的是 checks 全部结束，但**已经失败的 check 会让它第一轮就返回**；`failedJobs` 里是没成功的 Actions job。要更快返回可传 `fail_fast: true`；只想看某个事件的 check 用 `event`（如 `push`）。遇到等待审批的 workflow 立即返回 `status: "awaiting_approval"`，不会挂到超时。
- `get-github-workflow-jobs`：SDK 分页，一个 run 有 72 个 job 也会全部返回（旧版只返回前 30 个，第 31 个之后既列不出也选不中）。
- `read-github-ci-logs`：job 还在 `queued` 时返回 `{ ok: false }`，提示用 `watch-github-run` 等它开始；日志原样落盘到 `~/.cache/pi/github/ci-logs/<owner>/<repo>/<run_id>/<job_id>.log`（保留 runner 时间戳与 ANSI），同一 job 重复调用命中缓存，不重复下载。
- 工具**不做**日志截断、清洗或回显；拿到的是文件路径 + 行号，正文自己读。

## 与相邻工具的分工

- `read-github-pr-status`（快照即返）vs `wait-github-pr-checks`（阻塞轮询到检查结束）：前者用来定位，后者用来等结果。
- `watch-github-run`：已知 run_id、要等这个 run 跑完时用。
- `list-github-workflow-runs`：适合「某个 workflow 最近一次跑得怎么样」这类不需要 PR 上下文的场景。

## 反例

- 直接调 `read-github-ci-logs` 之类的工具名 —— 它们只经 codemode 暴露，必须先 `call(...)`。
- 用 job 名称去调 `read-github-ci-logs` —— 它只认 id，名称先经 `get-github-workflow-jobs` 转成 id。
- 为了拿日志去 Bash 跑 `gh api /repos/.../actions/runs/<id>/jobs` —— 直接用 `get-github-workflow-jobs`，分页与 id 提取已经处理好。
- 把整份日志读进上下文（`text(await fs.read(log_file))`）—— 先用索引里的行号区间，或对 `log_file` 做 Grep。
