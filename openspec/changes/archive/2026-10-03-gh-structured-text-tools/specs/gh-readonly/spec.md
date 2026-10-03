# Spec Delta

## MODIFIED Requirements

### Requirement: issue 与 PR 查询

查询 issue / PR 详情与列表。列表的两条取数分支 MUST 归一成同一套记录后再渲染：带关键词的搜索走 octokit（`gh issue list --search` 的 state 默认 open 会漏 closed / merged），不带关键词的浏览走系统 `gh` CLI 的 `gh issue list --json` / `gh pr list --json`。两条分支的行列表格式 MUST 一致（TSV，列由 `fields` 决定，未给 `repo` 时多一列 repo；浏览分支只查一个仓库，因此不带 repo 列），文本 MUST 由同一套渲染器产出。`author` / `assignee` 都接受 `@me`（当前登录用户）：值最终进入 GitHub 的搜索 / 过滤 API，由该 API 解析 `@me`，因此本仓库的 octokit 路径 MUST NOT 自行展开（客户端展开只是多一次请求，2026-09-29 已移除）。

#### Scenario: 按编号查询详情

- **WHEN** 指定 repo 与编号查询 issue 或 PR
- **THEN** 返回结构化详情（标题、状态、正文、作者、时间、labels、assignees、comments 等；PR 含变更统计与 reviews）

#### Scenario: 列表与跨仓库搜索

- **WHEN** 指定 repo 列出 issue / PR（支持 state / label / author / assignee / milestone / limit 过滤）
- **THEN** 返回列表；未指定 repo 且带关键词时退化为跨 GitHub 搜索（不拼接 `repo:` 限定符，避免 gh 误解析）

#### Scenario: 浏览分支经 --json 归一化

- **WHEN** 不带关键词列出 issue / PR
- **THEN** 调用 `gh issue list --json` / `gh pr list --json` 取结构化数据，再归一到与搜索分支相同的记录（`state` 转小写、`merged` 由 `mergedAt` 推断、`comments` 取评论数、日期取日期部分），文本与载荷都从这份记录产出

#### Scenario: 带关键词的搜索走 octokit 且不做 @me 展开

- **WHEN** 带关键词查询 issue / PR
- **THEN** 请求经 octokit 发出，且每个请求都在带 client 缓存与「401 丢缓存重试一次」的调用路径内：缓存的 token 失效时自动换新 token 重试一次，而不是直接失败
- **WHEN** `author` / `assignee` 传 `@me`
- **THEN** 值按字面量进入查询串（`author:@me` / `assignee:@me`），不发起 `users.getAuthenticated` 请求；`@me` 由搜索 / 过滤 API 解析为当前登录用户，不带关键词的 `gh` 路径同样可用（gh 在 GraphQL 过滤分支自行展开，走搜索分支时按字面量转发）

#### Scenario: PR diff 的变更统计来自 diff 本身

- **WHEN** 调用 `read-github-pr-diff`
- **THEN** 文本仍是 `gh pr diff` 的原始输出（该命令没有 `--json`），结构化的变更统计由同一份 diff 解析得出：每个文件的增删行数、总计与变更文件数，含重命名（`oldPath`）与二进制文件（0 行变更）

### Requirement: workflow run 与 job 查询

`get-github-workflow-jobs` 列出一个 workflow run 的全部 job，`list-github-workflow-runs` 列出仓库的 run。job 列表负责把 job 名称/状态映射成日志读取需要的 `job_id`。`list-github-workflow-runs` MUST 走 `gh run list --json` 并自行渲染行列表（`id 状态 结论 工作流 分支 事件 日期 链接`），`watch-github-run` MUST 在 `gh run watch` 结束后额外取一次 `gh run view --json` 才能在载荷里给出最终状态（`gh run watch` 没有 `--json`，其文本只有过程）。

#### Scenario: 列出 run 的全部 job

- **WHEN** 调用 `get-github-workflow-jobs`（`run_id` 必填、`repo` 可选，缺省用当前目录解析）
- **THEN** 走 octokit 的 `actions.listJobsForWorkflowRun` 并跟随 Link 分页（每页 100 条），返回 JSON `{total_count, jobs:[{id, run_id, run_url, name, status, conclusion, html_url, steps:[{name, number, status, conclusion, started_at}]}]}`；run 的 job 数超过单页上限（端点默认 30）时也必须全部返回

#### Scenario: 等待结束的 run 带最终状态

- **WHEN** `watch-github-run` 的 `gh run watch` 正常结束
- **THEN** 文本仍是原来的完成报告，载荷带 `gh run view --json` 取到的最终状态（id、状态、结论、工作流、分支、事件、时间、链接）

### Requirement: 结构化结果

以下 gh 工具在结果上 MUST 携带与其文本输出同源的机器可读结果 `structuredResult`：`read-github-issue`、`read-github-pr`、`read-github-issue-comments`、`read-github-pr-comments`、`read-github-pr-status`、`get-github-workflow-jobs`、`read-github-ci-logs`、`download-github-release-assets`、`wait-github-pr-checks`、`wait-github-commit-checks`，以及 `list-github-issues`、`list-github-prs`、`list-github-releases`、`list-github-workflow-runs`、`read-github-repo`、`read-github-release`、`read-github-pr-diff`、`watch-github-run`。

`structuredResult` 是 Result：`{ ok: true; value }` 表示成功，`value` MUST 与该工具注册时声明的 `structuredSchema` 匹配；`{ ok: false; error }` 表示工具的结构化失败（`read-github-ci-logs` 的「job 不存在 / 仍在排队」与 `download-github-release-assets` 的「release 没有资产」MUST 走这一支），`error` MUST 是可直接展示的错误说明。`structuredResult` MUST NOT 改变工具面向模型的 `content` 文本、既有 `details` 字段或 `isError` 语义。

后半组工具（走 `--json` 的那 8 个）的 `value` MUST 是 gh 的 JSON 加一个 `text` 字段，`text` MUST 与该次调用的工具输出逐字一致；行列表类工具的 JSON 条目 MUST 给出**全部**命中，MUST NOT 跟着文本的 2000 行 / 50KB 截断而减少。

#### Scenario: 成功结果带结构化 value

- **WHEN** 调用上述任一工具并成功取得数据
- **THEN** `structuredResult` 为 `{ ok: true, value }`，`value` 与文本输出同源且与该工具声明的 `structuredSchema` 匹配

#### Scenario: 未找到类结果走 ok:false

- **WHEN** `read-github-ci-logs` 找不到 job 或 job 仍在排队，或 `download-github-release-assets` 的 release 没有资产
- **THEN** `structuredResult` 为 `{ ok: false, error }`，同时工具的 `content` 文本与 `isError` 与改动前一致

#### Scenario: 文本输出与 details 不变

- **WHEN** 调用上述任一工具
- **THEN** `content` 的文本与 `details` 与加 `structuredResult` 之前相同（改成 `--json` 的那几个工具除外：它们的文本按新的渲染器输出）

#### Scenario: 行列表的载荷不跟着文本截断

- **WHEN** 命中数很多，文本被输出预算截断
- **THEN** 载荷仍包含全部条目，`text` 是被截断的那份

#### Scenario: 未覆盖的工具不受影响

- **WHEN** 调用不在上述列表中的 gh 工具
- **THEN** 结果不带 `structuredResult`，codemode 侧也因此不把它算作可调用工具

## ADDED Requirements

### Requirement: release 与仓库文本工具的输出

`list-github-releases`、`read-github-release`、`read-github-repo` 的输出 MUST 由我们自己从 `gh … --json` 渲染（不再用 gh 的表格 / 字段块 / markdown），格式固定且只依赖 schema 声明过的字段：

- release 列表：一行一个 release，列为 `tag`、标记（`latest` / `prerelease` / `draft`，逗号连接）、发布日期、标题；空结果是 `(no releases)`。
- release 详情：标题行、元信息行（发布日期、标记、作者、链接）、资产清单（每个资产的名字、字节数、下载数）、正文。
- 仓库概览：标题行、事实行（可见性、主语言、默认分支、star / fork / issue / PR 计数）、链接行、日期与许可行。

日期 MUST 取自 ISO 时间戳的日期部分（`YYYY-MM-DD`）。

#### Scenario: 列出 release

- **WHEN** 调用 `list-github-releases`（`repo` / `limit` 可选）
- **THEN** 每个 release 一行，标记与日期都在，载荷给出 gh 的 JSON

#### Scenario: 读取 release 详情

- **WHEN** 调用 `read-github-release`（`tag` 必填、`repo` 可选）
- **THEN** 输出元信息、资产清单与正文，载荷给出 gh 的 JSON（含资产数组）

#### Scenario: 读取仓库概览

- **WHEN** 调用 `read-github-repo`（`repo` 可选，缺省用当前目录解析）
- **THEN** 输出仓库概览四行，载荷给出 gh 的 JSON（含 `nameWithOwner`、语言、默认分支、计数、许可等）

#### Scenario: 空的 release 列表

- **WHEN** 仓库没有任何 release
- **THEN** 文本是 `(no releases)`，仍是成功结果（载荷的 `releases` 为空数组）
