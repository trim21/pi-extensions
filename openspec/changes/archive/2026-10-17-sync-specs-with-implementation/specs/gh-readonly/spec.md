# Spec Delta

## MODIFIED Requirements

### Requirement: 工具注册门控

工具集仅在环境可用时注册。

#### Scenario: gh 缺失不注册

- **WHEN** PATH 中找不到 `gh`
- **THEN** 不注册任何工具，session 开始时 notify warning

#### Scenario: Windows 不注册

- **WHEN** 运行在 Windows
- **THEN** 不注册任何工具，notify warning

### Requirement: 命令失败契约

GitHub 请求失败（HTTP 非 2xx、网络错误、token 无效 / 过期）MUST 抛出带上下文的错误：HTTP 状态、GitHub 的 message；搜索请求带触发请求的参数。认证失败（401）MUST 丢缓存 token 重试一次，仍失败才报错。调用方中止 MUST 通过 `signal` 传给请求，被中止的请求 MUST 记为失败而不是成功。

取数据路径 MUST NOT 再依赖 `gh` 的退出码与 stderr 文本构造错误；`gh` 子进程只剩「当前仓库」解析与 token 获取两处：前者失败抛 `GhError`（argv + 输出上下文），后者失败抛带 stderr 的普通 `Error` 并提示 `gh auth login`。

#### Scenario: REST 请求失败报错

- **WHEN** 一次 GitHub 请求返回错误状态（例如 404 / 403 / 500）
- **THEN** 抛出 `GithubApiError`，带 HTTP 状态与 GitHub 的 message；搜索分支额外带触发该请求的工具参数，`status` 为 404 时调用方可用 `isNotFound` 区分「不存在」与真失败

#### Scenario: gh 子进程失败报错

- **WHEN** `gh repo view` 非零退出
- **THEN** 抛出带完整调用输入与输出上下文的 `GhError`
- **WHEN** `gh auth token` 非零退出
- **THEN** 抛出带 stderr 的普通 `Error`，提示先执行 `gh auth login`

#### Scenario: 超时/中止标注

- **WHEN** 调用方中止（Esc）、请求超时，或 `gh` 子进程超过 10 分钟预算
- **THEN** 该次调用以失败结束（不是把空结果当成成功）；`gh` 子进程超时 / 中止先 SIGTERM、5 秒后 SIGKILL，被 kill 的进程退出码记为失败而非成功（`auth token` 使用 10 秒超时）

### Requirement: issue 与 PR 查询

查询 issue / PR 详情与列表，全部 MUST 走 octokit 的 REST 端点，不再 spawn `gh`。列表的两条分支 MUST 归一成同一套记录后进入结构化载荷：带关键词的搜索走 `/search/issues`（搜索 API 解析 `@me`），不带关键词的浏览走 `issues.listForRepo` / `pulls.list`（REST 的 issues 列表混着 PR，按 `pull_request` 键过滤掉）。浏览分支的 `author` / `assignee` MUST 按字面量传给 REST，MUST NOT 由本仓库展开 `@me`（REST 只接受用户名；`@me` 仅在关键词搜索路径可用）。`merged` MUST 由 `merged_at` 推断（搜索 API 把已合并的 PR 报成 closed）。

#### Scenario: 按编号查询详情

- **WHEN** 指定 repo 与编号查询 issue 或 PR
- **THEN** 返回 `issues.get` / `pulls.get` 的 JSON（标题、状态、正文、作者、时间、labels、assignees、comments 等；PR 含变更统计）作为唯一输出

#### Scenario: 列表与跨仓库搜索

- **WHEN** 指定 repo 列出 issue / PR（支持 state / label / author / assignee / milestone / limit 过滤）
- **THEN** 走 REST 列表端点并分页到 limit；未指定 repo 且带关键词时退化为跨 GitHub 搜索（不拼接 `repo:` 限定符）

#### Scenario: 浏览分支经 REST 列表归一化

- **WHEN** 不带关键词列出 issue / PR
- **THEN** 把 REST 响应归一到与搜索分支相同的记录（`state` 小写、`merged` 由 `merged_at` 推断、`comments` 取数字、日期取日期部分），载荷从这份记录产出

#### Scenario: 带关键词的搜索走 octokit 且不做 @me 展开

- **WHEN** 带关键词查询 issue / PR
- **THEN** 请求经 octokit 发出，且每个请求都在带 client 缓存与「401 丢缓存重试一次」的调用路径内：缓存的 token 失效时自动换新 token 重试一次，而不是直接失败
- **WHEN** `author` / `assignee` 传 `@me`
- **THEN** 值按字面量进入查询串（`author:@me` / `assignee:@me`），不发起 `users.getAuthenticated` 请求；`@me` 由搜索 API 解析为当前登录用户

#### Scenario: 浏览路径不展开 @me

- **WHEN** 不带关键词列出 issue / PR，且 `author` / `assignee` 传 `@me`
- **THEN** 该值按字面量作为 REST 查询参数发出（不发起 `users.getAuthenticated`），因此不会匹配到当前用户——需要 `@me` 语义时用关键词搜索路径

#### Scenario: PR diff 的变更统计来自 diff 本身

- **WHEN** 调用 `read-github-pr-diff`
- **THEN** diff 由 `pulls.get` 带 `mediaType: { format: "diff" }` 取回（GitHub 返回 diff 文本），结构化的变更统计由同一份 diff 解析得出：每个文件的增删行数、总计与变更文件数，含重命名（`oldPath`）与二进制文件（0 行变更）

### Requirement: workflow run 与 job 查询

`get-github-workflow-jobs` 列出一个 workflow run 的全部 job（octokit `actions.listJobsForWorkflowRun` 分页），`list-github-workflow-runs` 列出仓库的 run：不带 `workflow` 时走 `actions.listWorkflowRunsForRepo`，带 `workflow` 时先经 `actions.listRepoWorkflows` 按名字或文件名解析成 id，再走 `actions.listWorkflowRuns`。两者都 MUST NOT spawn `gh`。`watch-github-run` MUST 轮询 `actions.getWorkflowRun` 直到运行结束（`status` 为 `completed`），不再执行 `gh run watch`。

#### Scenario: 列出 run 的全部 job

- **WHEN** 调用 `get-github-workflow-jobs`（`run_id` 必填、`repo` 可选，缺省用当前目录解析）
- **THEN** 返回 JSON `{total_count, jobs:[{id, run_id, run_url, name, status, conclusion, html_url, steps:[…]}]}`；run 的 job 数超过单页上限（端点默认 30）时也必须全部返回

#### Scenario: 等待结束的 run 带最终状态

- **WHEN** `watch-github-run` 等到运行结束
- **THEN** 结构化载荷带 `actions.getWorkflowRun` 的最终状态（id、状态、结论、工作流、分支、事件、时间、链接）

### Requirement: release 资产下载

`download-github-release-assets` MUST 走 octokit：先 `releases.getReleaseByTag`（缺 `tag` 时 `getLatestRelease`）解析真实 tag 与该 release 的资产清单，再按资产 id 用 `rawFetch` + `Accept: application/octet-stream` 流式写入 `~/.cache/pi/github/releases/<owner>/<repo>/<tag>/`；`archive` 参数改用 zipball / tarball 端点（仓库源码归档）。`pattern` MUST 由本仓库按 glob 匹配资产名（逗号分隔多个）。结果 MUST 由目录实读得出（文件名 + `stat` 大小，按名排序），不信上传方的响应。同名文件已存在且大小一致 MUST 跳过，否则 MUST 覆盖（避免把半截文件当成已完成）。`pattern` 未命中时 MUST 给出该 release 的可选资产名。

结构化载荷的 `value`：

```json
{
  "repo": "cli/cli",
  "tag": "v2.100.0",
  "dir": "/home/user/.cache/pi/github/releases/cli/cli/v2.100.0",
  "files": [
    {
      "name": "gh_2.100.0_checksums.txt",
      "path": "/home/user/.cache/pi/github/releases/cli/cli/v2.100.0/gh_2.100.0_checksums.txt",
      "bytes": 1971
    }
  ]
}
```

#### Scenario: 参数与缺省

- **WHEN** 调用 `download-github-release-assets`（`tag` 可选、`repo` / `pattern` / `archive` 可选）
- **THEN** 缺 `tag` 用 latest；`pattern` 按 glob 匹配资产名；`archive` 取源码归档而不是资产；`pattern` 与 `archive` 互斥，同时给出直接报错

#### Scenario: 落盘目录与缓存复用

- **WHEN** 下载完成
- **THEN** 结果列出目录里的文件与大小；再次调用时同名同大小的文件被跳过，不重复下载
- **AND** 目录由 `releaseAssetDir` 统一计算（tag 是 git ref 名、可以含 `/`，只有单个路径段安全的字符保留，`..` 这类段整体降级为 `_`，因此 tag 逃不出自己的目录），`files` 列出目录里**当前**的全部普通文件（含此前已缓存的），内容不回显

#### Scenario: pattern 未命中时给出可选资产名

- **WHEN** `pattern` 没有匹配到任何资产
- **THEN** 报错并列出该 release 实际可选的资产名

#### Scenario: release 没有资产

- **WHEN** 目标 release 没有资产，且请求的不是源码包
- **THEN** 结构化结果为 `{ ok: false, error }`，错误说明没有资产（可改用 `archive`）

### Requirement: 状态快照与 run 级等待

`read-github-pr-status` 的 checks 状态快照（commit statuses + check runs + 无 check run 的 check suites）继续走 octokit 并立即返回；`wait-github-pr-checks` / `wait-github-commit-checks` 的轮询与判定见独立 spec（`openspec/specs/wait-github-pr-checks/`）。`watch-github-run` 改为按固定间隔轮询 `actions.getWorkflowRun`（间隔与上限沿用等待工具的 30s / 600s），轮询期间 MUST NOT 输出进度（这条路径上没有会消费进度的调用方）；超过上限时 MUST 以超时结束而不是挂住。

#### Scenario: 状态快照

- **WHEN** 调用 `read-github-pr-status`（`number` 必填、`repo` 可选）
- **THEN** 走 octokit 读该 PR head commit 的 commit statuses、check runs 与 check suites，立即返回 JSON `{pr, repo, head_sha, checks:[{name, bucket, event, run_id, job_id, url, suite_id}]}`，不等待；`bucket` 为 pass / fail / pending / skipped / action_required；check run 条目的 `run_id` / `job_id` 由 `details_url` 解析，suite 条目取自匹配到的 workflow run、`job_id` 为 null，非 Actions 的 check 两者为 null；`suite_id` 为该检查所属 suite（commit status 为 null）

#### Scenario: 等待审批的 workflow 也在快照里

- **WHEN** 该 head commit 上有等待维护者审批的 workflow（只有 check suite 与 workflow run，没有 check run）
- **THEN** 快照里出现对应条目（名字、event 与链接取自其 workflow run），`bucket` 为 `action_required`、`suite_id` 为其 suite id，不再被静默省略

#### Scenario: run 级等待

- **WHEN** `watch-github-run` 等待中
- **THEN** 结束后给出最终状态与载荷（期间不输出轮询进度）；超过上限以超时错误结束，不挂住调用方
