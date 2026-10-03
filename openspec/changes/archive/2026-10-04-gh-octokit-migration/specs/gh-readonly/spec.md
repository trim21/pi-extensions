# Spec Delta

## MODIFIED Requirements

### Requirement: 输出统一截断

从 GitHub 取回的数据 MUST 在进入模型可见输出前统一截断（`content` 的文本 2000 行 / 50KB），`details` 带 `truncated` 标志。截断 MUST NOT 影响结构化载荷（载荷给全量条目）。这条规则与迁移前一致，只是数据的来源从 gh 子进程的 stdout 变成 octokit 的响应；二进制下载与 CI 日志落盘不受此预算影响（它们不进模型上下文）。

#### Scenario: 超限截断

- **WHEN** 返回内容超过 2000 行或 50KB
- **THEN** 模型看到的文本被截断并标记，`details.truncated` 为真，结构化载荷仍给全部条目

### Requirement: 命令失败契约

GitHub 请求失败（HTTP 非 2xx、网络错误、token 无效/过期）MUST 抛出带上下文的错误：HTTP 状态、请求路径与 GitHub 的 message，并保留「调用输入」以便定位。认证失败（401）MUST 丢缓存 token 重试一次，仍失败才报错。调用方中止 MUST 通过 `signal` 传给请求，被中止的请求 MUST 记为中失败而不是成功。MUST NOT 再依赖 gh 的退出码与 stderr 文本构造错误。

#### Scenario: 非零退出报错

- **WHEN** 一次 GitHub 请求返回错误状态（例如 404 / 403 / 500）
- **THEN** 抛出带 HTTP 状态、请求路径与 GitHub message 的错误，错误里能看出被调用的工具与输入

#### Scenario: 超时/中止标注

- **WHEN** 调用方中止（Esc）或请求超时
- **THEN** 该次调用以失败结束，错误标注为中失败（不是把空结果当成成功）

### Requirement: issue 与 PR 查询

查询 issue / PR 详情与列表，全部 MUST 走 octokit 的 REST 端点，不再 spawn `gh`。列表的两条分支 MUST 归一成同一套记录后再渲染（TSV，列由 `fields` 决定）：带关键词的搜索走 `/search/issues`（搜索 API 解析 `@me`），不带关键词的浏览走 `issues.listForRepo` / `pulls.list`。浏览分支的 `author` / `assignee` MUST 按字面量传给 REST，MUST NOT 由本仓库展开 `@me`（REST 只接受用户名；`@me` 仅在关键词搜索路径可用）。`merged` MUST 由 `merged_at` 推断（搜索 API 把已合并的 PR 报成 closed）。

#### Scenario: 按编号查询详情

- **WHEN** 指定 repo 与编号查询 issue 或 PR
- **THEN** 返回 `issues.get` / `pulls.get` 的 JSON（标题、状态、正文、作者、时间、labels、assignees、comments 等；PR 含变更统计），文本与结构化载荷同源

#### Scenario: 列表与跨仓库搜索

- **WHEN** 指定 repo 列出 issue / PR（支持 state / label / author / assignee / milestone / limit 过滤）
- **THEN** 走 REST 列表端点并分页到 limit；未指定 repo 且带关键词时退化为跨 GitHub 搜索（不拼接 `repo:` 限定符）

#### Scenario: 浏览分支经 --json 归一化

- **WHEN** 不带关键词列出 issue / PR
- **THEN** 把 REST 响应归一到与搜索分支相同的记录（`state` 小写、`merged` 由 `merged_at` 推断、`comments` 取数字、日期取日期部分），文本与载荷都从这份记录产出

#### Scenario: 带关键词的搜索走 octokit 且不做 @me 展开

- **WHEN** 带关键词查询 issue / PR
- **THEN** 请求经 octokit 发出，且每个请求都在带 client 缓存与「401 丢缓存重试一次」的调用路径内
- **WHEN** `author` / `assignee` 传 `@me`
- **THEN** 值按字面量进入搜索查询串，由搜索 API 解析为当前登录用户

#### Scenario: 浏览路径不展开 @me

- **WHEN** 不带关键词列出 issue / PR，且 `author` / `assignee` 传 `@me`
- **THEN** 该值按字面量作为 REST 查询参数发出（不发起 `users.getAuthenticated`），因此不会匹配到当前用户——需要 `@me` 语义时用关键词搜索路径

#### Scenario: PR diff 的变更统计来自 diff 本身

- **WHEN** 调用 `read-github-pr-diff`
- **THEN** diff 由 `pulls.get` 带 `mediaType: { format: "diff" }` 取回（GitHub 返回 diff 文本），结构化的变更统计由同一份 diff 解析得出：每个文件的增删行数、总计与变更文件数，含重命名（`oldPath`）与二进制文件（0 行变更）

### Requirement: workflow run 与 job 查询

`get-github-workflow-jobs` 列出一个 workflow run 的全部 job（octokit `actions.listJobsForWorkflowRun` 分页），`list-github-workflow-runs` 列出仓库的 run（octokit `actions.listWorkflowRunsForRepo`，`workflow` 参数先经 `actions.listRepoWorkflows` 按名字或文件名解析成 id）。两者都 MUST NOT spawn `gh`。`watch-github-run` MUST 轮询 `actions.getWorkflowRun` 直到运行结束（`status` 为 `completed`），不再执行 `gh run watch`。

#### Scenario: 列出 run 的全部 job

- **WHEN** 调用 `get-github-workflow-jobs`（`run_id` 必填、`repo` 可选，缺省用当前目录解析）
- **THEN** 返回 JSON `{total_count, jobs:[{id, run_id, run_url, name, status, conclusion, html_url, steps:[…]}]}`；run 的 job 数超过单页上限时也必须全部返回

#### Scenario: 等待结束的 run 带最终状态

- **WHEN** `watch-github-run` 等到运行结束
- **THEN** 输出完成报告，结构化载荷带 `actions.getWorkflowRun` 的最终状态（id、状态、结论、工作流、分支、事件、时间、链接）

### Requirement: CI 日志读取

`read-github-ci-logs` 按 job 下载日志：job 元数据走 octokit `actions.getJobForWorkflowRun`，日志走 octokit `actions.downloadJobLogsForWorkflowRun`（GitHub 只有按 job id 取日志的端点，没有按 job 名称的），响应原样写入 `~/.cache/pi/github/ci-logs/<owner>/<repo>/<runId>/<jobId>.log`。工具不返回日志内容，也不做截断或清洗——它把日志原样落盘，并给出解析后的 steps 与每个 step 在文件中的行号范围，内容由模型自己读文件。同一 job 的请求 MUST 串行化。

#### Scenario: 参数

- **WHEN** 调用 `read-github-ci-logs`
- **THEN** 只接受 `job_id`（必填）与 `repo`（可选），不接受 job 名称

#### Scenario: 返回 steps 与原始日志文件

- **WHEN** job 已运行且有日志
- **THEN** 返回 `{name, id, status, conclusion, log_file, steps:[{number, name, conclusion, start_line?, end_line?}]}`，`log_file` 是完整原始日志的落盘路径

#### Scenario: 未运行的 step 没有行号

- **WHEN** 某个 step 被跳过或没有产生 `##[group]` header
- **THEN** 该 step 不带 `start_line` / `end_line`，不猜行号

#### Scenario: job 尚未开始

- **WHEN** job 仍在排队、没有日志
- **THEN** 结构化结果为 `{ ok: false, error }`，文本说明 job 尚未开始

#### Scenario: 日志缓存

- **WHEN** 同一 job 的日志已经落盘
- **THEN** 复用已有文件，不重复下载；不同 job MUST NOT 互相覆盖（路径含 run id 与 job id）

### Requirement: release 资产下载

`download-github-release-assets` MUST 走 octokit：先 `releases.getReleaseByTag`（缺 `tag` 时 `getLatestRelease`）解析真实 tag 与该 release 的资产清单，再用 `repos.getReleaseAsset`（`Accept: application/octet-stream`）流式写入 `~/.cache/pi/github/releases/<owner>/<repo>/<tag>/`；`--archive` 参数改用 `repos.downloadZipballArchive` / `downloadTarballArchive`（仓库源码归档）。`pattern` MUST 由本仓库按 glob 匹配资产名（逗号分隔多个）。结果 MUST 由目录实读得出（文件名 + `stat` 大小，按名排序），不信上传方的响应。同名文件已存在且大小一致 MUST 跳过，否则 MUST 覆盖（避免把半截文件当成已完成）。`pattern` 未命中时 MUST 给出该 release 的可选资产名。

#### Scenario: 参数与缺省

- **WHEN** 调用 `download-github-release-assets`（`tag` 可选、`repo` / `pattern` / `archive` 可选）
- **THEN** 缺 `tag` 用 latest；`pattern` 按 glob 匹配资产名；`archive` 取源码归档而不是资产

#### Scenario: 落盘目录与缓存复用

- **WHEN** 下载完成
- **THEN** 结果列出目录里的文件与大小；再次调用时同名同大小的文件被跳过，不重复下载

#### Scenario: pattern 未命中时给出可选资产名

- **WHEN** `pattern` 没有匹配到任何资产
- **THEN** 报错并列出该 release 实际可选的资产名

#### Scenario: release 没有资产

- **WHEN** 目标 release 没有资产
- **THEN** 结构化结果为 `{ ok: false, error }`，文本说明没有资产

### Requirement: 状态快照与 run 级等待

`read-github-pr-status` 的 checks 状态快照（commit statuses + check runs）继续走 octokit，与迁移前一致；`wait-github-pr-checks` / `wait-github-commit-checks` 的轮询与判定不变。`watch-github-run` 改为按固定间隔轮询 `actions.getWorkflowRun`（间隔与上限沿用等待工具的 30s / 600s），轮询期间 MUST 通过 `onUpdate` 报告当前状态；超过上限时 MUST 以超时结束而不是挂住。

#### Scenario: 状态快照

- **WHEN** 调用 `read-github-pr-status`
- **THEN** 返回该 PR head commit 上全部 status 与 check run 的归并结果（pass / fail / pending / skipped 桶）

#### Scenario: run 级等待

- **WHEN** `watch-github-run` 等待中
- **THEN** 每次轮询报告当前 `status` / `conclusion`，结束后给出最终状态与载荷

### Requirement: 结构化结果

以下 gh 工具在结果上 MUST 携带与其文本输出同源的机器可读结果 `structuredResult`：`read-github-issue`、`read-github-pr`、`read-github-issue-comments`、`read-github-pr-comments`、`read-github-pr-status`、`get-github-workflow-jobs`、`read-github-ci-logs`、`download-github-release-assets`、`wait-github-pr-checks`、`wait-github-commit-checks`、`list-github-issues`、`list-github-prs`、`list-github-releases`、`list-github-workflow-runs`、`read-github-repo`、`read-github-release`、`read-github-pr-diff`、`watch-github-run`。

`structuredResult` 是 Result：`{ ok: true; value }` 表示成功，`value` MUST 与该工具注册时声明的 `structuredSchema` 匹配；`{ ok: false; error }` 表示工具的结构化失败（`read-github-ci-logs` 的「job 不存在 / 仍在排队」与 `download-github-release-assets` 的「release 没有资产」MUST 走这一支），`error` MUST 是可直接展示的错误说明。`structuredResult` MUST NOT 改变工具面向模型的 `content` 文本、`details` 字段或 `isError` 语义。

迁移到 octokit 后，`value` MUST 是 REST 响应的原物（字段名保持 GitHub REST 的命名：`html_url` / `created_at` / `user.login` / `labels[].name`），MUST NOT 映射回 gh GraphQL 的字段名；行列表类工具的 `value` 仍是 `{ text, … }`，条目 MUST 给全部命中，MUST NOT 跟着文本预算截断。

#### Scenario: 成功结果带结构化 value

- **WHEN** 调用上述任一工具并成功取得数据
- **THEN** `structuredResult` 为 `{ ok: true, value }`，`value` 与文本输出同源且与该工具声明的 `structuredSchema` 匹配

#### Scenario: 未找到类结果走 ok:false

- **WHEN** `read-github-ci-logs` 找不到 job 或 job 仍在排队，或 `download-github-release-assets` 的 release 没有资产
- **THEN** `structuredResult` 为 `{ ok: false, error }`，同时工具的 `content` 文本与 `isError` 与迁移前一致

#### Scenario: 文本输出与 details 不变

- **WHEN** 调用上述任一工具
- **THEN** 除字段命名（REST 原物）与 `watch-github-run` 的进度文本外，`content` 与 `details` 的结构与迁移前一致

#### Scenario: 行列表的载荷不跟着文本截断

- **WHEN** 命中数很多，文本被输出预算截断
- **THEN** 载荷仍包含全部条目，`text` 是被截断的那份

#### Scenario: 未覆盖的工具不受影响

- **WHEN** 调用不在上述列表中的 gh 工具
- **THEN** 结果不带 `structuredResult`，codemode 侧也因此不把它算作可调用工具

### Requirement: release 与仓库文本工具的输出

`list-github-releases`、`read-github-release`、`read-github-repo` 的输出 MUST 由我们自己从 octokit 的 REST 响应渲染（格式与迁移前一致，不再有 gh 的表格 / 字段块 / markdown）：

- release 列表：一行一个 release，列为 `tag`、标记（`latest` / `prerelease` / `draft`，逗号连接）、发布日期、标题；空结果是 `(no releases)`。
- release 详情：标题行、元信息行（发布日期、标记、作者、链接）、资产清单（每个资产的名字、字节数、下载数）、正文。
- 仓库概览：标题行、事实行（可见性、主语言、默认分支、star / fork / issue / PR 计数）、链接行、日期与许可行。

日期 MUST 取自 ISO 时间戳的日期部分（`YYYY-MM-DD`）。

#### Scenario: 列出 release

- **WHEN** 调用 `list-github-releases`（`repo` / `limit` 可选）
- **THEN** 每个 release 一行，标记与日期都在，载荷给出 REST 响应

#### Scenario: 读取 release 详情

- **WHEN** 调用 `read-github-release`（`tag` 必填、`repo` 可选）
- **THEN** 输出元信息、资产清单与正文，载荷给出 REST 响应（含资产数组）

#### Scenario: 读取仓库概览

- **WHEN** 调用 `read-github-repo`（`repo` 可选，缺省用当前目录解析）
- **THEN** 输出仓库概览四行，载荷给出 REST 响应（含 `full_name` / `language` / `default_branch` / 计数 / 许可等）

#### Scenario: 空的 release 列表

- **WHEN** 仓库没有任何 release
- **THEN** 文本是 `(no releases)`，仍是成功结果（载荷的 `releases` 为空数组）
