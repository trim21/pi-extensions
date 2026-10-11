# Spec Delta

## ADDED Requirements

### Requirement: gh 工具只经 codemode 曝光

gh 工具集 MUST 经工具总线的 codemode-only 注册路径注册，曝光方式由代码决定。这些工具 MUST 登记进总线、MUST NOT 交给 pi：它们 MUST NOT 出现在模型可见的工具清单与 active 列表里，MUST NOT 产生面向模型的 `promptSnippet` / `promptGuidelines`；模型只能在 `codemode` 的工具描述里看到它们的参数与返回类型。命中 `disabledTools` 时 MUST NOT 注册（脚本里也调不到）。

#### Scenario: 模型不可直调

- **WHEN** 会话加载 gh 工具集
- **THEN** 模型可见的工具清单里没有任何 `read-github-*` / `list-github-*` / `wait-github-*` / `watch-github-run` / `get-github-workflow-jobs` / `download-github-release-assets`

#### Scenario: 脚本仍可按名调用

- **WHEN** codemode 脚本调用某个 gh 工具并传入合法参数
- **THEN** 得到该工具的结构化载荷，行为与经总线直接执行一致

#### Scenario: 禁用即不注册

- **WHEN** `disabledTools` 命中某个 gh 工具（可带 `models` 条件）
- **THEN** 该工具既不交给 pi 也不登记进总线，脚本调用它得到「工具不可用」错误

### Requirement: 结构化结果是唯一输出

gh 工具 MUST 只用结构化结果交付数据：成功是 `{ ok: true; value }`（`value` 与该工具声明的 `structuredSchema` 匹配），结构化失败是 `{ ok: false; error }`（`error` 可直接展示）。它们是 codemode 脚本工具，结果 MUST NOT 套用 pi 的 `AgentToolResult`——没有 `content` 数组、也没有 `details`。`value` MUST 是 GitHub REST 响应的原物（字段名保持 REST 命名：`html_url` / `created_at` / `user.login` / `labels[].name`），MUST NOT 映射回 gh GraphQL 的字段名，也 MUST NOT 套一层 `text` 镜像；列表类工具的 `value` MUST 给全部命中。

#### Scenario: 成功结果带结构化 value

- **WHEN** 调用任一 gh 工具并成功取得数据
- **THEN** 得到 `{ ok: true, value }`，`value` 与该工具声明的 `structuredSchema` 匹配，结果里没有 `content` / `details`

#### Scenario: 未找到类结果走 ok:false

- **WHEN** `read-github-ci-logs` 找不到 job 或 job 仍在排队，或 `download-github-release-assets` 的 release 没有资产
- **THEN** 得到 `{ ok: false, error }`，错误信息里说明原因

#### Scenario: 载荷不套文本镜像

- **WHEN** 调用任一 gh 工具
- **THEN** 载荷里没有 `text` 字段，需要什么字段由调用方从 `value` 自行投影

#### Scenario: 未覆盖的工具不受影响

- **WHEN** 调用不在 gh 工具集里的工具
- **THEN** 它不因为这个约定而改变自己的结果形状

## MODIFIED Requirements

### Requirement: issue 与 PR 查询

查询 issue / PR 详情与列表，全部 MUST 走 octokit 的 REST 端点，不再 spawn `gh`。列表的两条分支 MUST 归一成同一套记录后进入结构化载荷：带关键词的搜索走 `/search/issues`（搜索 API 解析 `@me`），不带关键词的浏览走 `issues.listForRepo` / `pulls.list`（REST 的 issues 列表混着 PR，按 `pull_request` 键过滤掉）。浏览分支的 `author` / `assignee` MUST 按字面量传给 REST，MUST NOT 由本仓库展开 `@me`（REST 只接受用户名；`@me` 仅在关键词搜索路径可用）。`merged` MUST 由 `merged_at` 推断（搜索 API 把已合并的 PR 报成 closed）。

#### Scenario: 按编号查询详情

- **WHEN** 指定 repo 与编号查询 issue 或 PR
- **THEN** 返回 `issues.get` / `pulls.get` 的 JSON（标题、状态、正文、作者、时间、labels、assignees、comments 等；PR 含变更统计）

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

`get-github-workflow-jobs` 列出一个 workflow run 的全部 job（octokit `actions.listJobsForWorkflowRun` 分页），`list-github-workflow-runs` 列出仓库的 run（octokit `actions.listWorkflowRunsForRepo`，`workflow` 参数先经 `actions.listRepoWorkflows` 按名字或文件名解析成 id）。两者都 MUST NOT spawn `gh`。`watch-github-run` MUST 轮询 `actions.getWorkflowRun` 直到运行结束（`status` 为 `completed`），不再执行 `gh run watch`。

#### Scenario: 列出 run 的全部 job

- **WHEN** 调用 `get-github-workflow-jobs`（`run_id` 必填、`repo` 可选，缺省用当前目录解析）
- **THEN** 返回 JSON `{total_count, jobs:[{id, run_id, run_url, name, status, conclusion, html_url, steps:[…]}]}`；run 的 job 数超过单页上限（端点默认 30）时也必须全部返回

#### Scenario: 等待结束的 run 带最终状态

- **WHEN** `watch-github-run` 等到运行结束
- **THEN** 结构化载荷带 `actions.getWorkflowRun` 的最终状态（id、状态、结论、工作流、分支、事件、时间、链接）

### Requirement: CI 日志读取

`read-github-ci-logs` 按 job 下载日志：job 元数据走 octokit `actions.getJobForWorkflowRun`，日志走 octokit `actions.downloadJobLogsForWorkflowRun`（GitHub 只有按 job id 取日志的端点，没有按 job 名称的），响应原样写入 `~/.cache/pi/github/ci-logs/<owner>/<repo>/<runId>/<jobId>.log`。工具不返回日志内容，也不做截断或清洗——它把日志原样落盘，并给出解析后的 steps 与每个 step 在文件中的行号范围，内容由调用方自己读文件。同一 job 的请求 MUST 串行化。

结构化载荷的 `value`：

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
- **THEN** 只接受 `job_id`（必填，正整数或数字字符串）与 `repo`（可选，缺省用当前目录解析），不接受 job 名称；该仓库查不到这个 job（404）时给出结构化失败，并提示 job id 来自 `get-github-workflow-jobs`

#### Scenario: 返回 steps 与原始日志文件

- **WHEN** job 已运行且有日志
- **THEN** 返回上述载荷：`log_file` 是该 job 的完整原始日志路径（保留 runner 时间戳与 ANSI，逐字节与 GitHub 交付的一致），`steps` 按 API 的 step 顺序列出 `number` / `name` / `conclusion`，并给出该 step 日志块在 `log_file` 中的 `start_line` / `end_line`（1-based，闭区间，可直接用于读取文件）

#### Scenario: 未运行的 step 没有行号

- **WHEN** 某个 step 被跳过或没有产生 `##[group]` header
- **THEN** 该 step 只带 `number` / `name` / `conclusion`，不带 `start_line` / `end_line`，不猜行号

#### Scenario: job 尚未开始

- **WHEN** job 仍在排队、没有日志
- **THEN** 结构化结果为 `{ ok: false, error }`，错误说明 job 尚未开始并指向 `watch-github-run`

#### Scenario: 日志缓存

- **WHEN** 同一 job 的日志已经落盘
- **THEN** 复用已有文件，不重复下载；不同 job MUST NOT 互相覆盖（路径含 run id 与 job id）

### Requirement: release 资产下载

`download-github-release-assets` MUST 走 octokit：先 `releases.getReleaseByTag`（缺 `tag` 时 `getLatestRelease`）解析真实 tag 与该 release 的资产清单，再用 `repos.getReleaseAsset`（`Accept: application/octet-stream`）流式写入 `~/.cache/pi/github/releases/<owner>/<repo>/<tag>/`；`archive` 参数改用 `repos.downloadZipballArchive` / `downloadTarballArchive`（仓库源码归档）。`pattern` MUST 由本仓库按 glob 匹配资产名（逗号分隔多个）。结果 MUST 由目录实读得出（文件名 + `stat` 大小，按名排序），不信上传方的响应。同名文件已存在且大小一致 MUST 跳过，否则 MUST 覆盖（避免把半截文件当成已完成）。`pattern` 未命中时 MUST 给出该 release 的可选资产名。

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
- **THEN** 走 octokit 读该 PR head commit 的 commit statuses、check runs 与 check suites，立即返回 JSON `{pr, repo, head_sha, checks:[{name, bucket, event, run_id, job_id, url, suite_id}]}`，不等待；`bucket` 为 pass / fail / pending / skipped / action_required，Actions 来源的 check 带 `run_id` / `job_id`（check run 由 `details_url` 解析，suite 条目取自 `check_suite_id` 匹配到的 workflow run），非 Actions 的 check 两者为 null；`suite_id` 为该检查所属 suite（commit status 为 null）

#### Scenario: 等待审批的 workflow 也在快照里

- **WHEN** 该 head commit 上有等待维护者审批的 workflow（只有 check suite 与 workflow run，没有 check run）
- **THEN** 快照里出现对应条目（名字、event 与链接取自其 workflow run），`bucket` 为 `action_required`、`suite_id` 为其 suite id，不再被静默省略

#### Scenario: run 级等待

- **WHEN** `watch-github-run` 等待中
- **THEN** 结束后给出最终状态与载荷（期间不输出轮询进度）；超过上限以超时错误结束，不挂住调用方

## REMOVED Requirements

### Requirement: 结构化结果

**Reason**: 该需求的前提是「结构化结果与文本输出同源、不改变面向模型的 `content` 与 details」；gh 工具不再产生文本输出后，结构化结果成为唯一输出，契约整体改写（见 ADDED「结构化结果是唯一输出」）。

**Migration**: 调用方改为只读 `structuredResult.value`；`value` 里不再有 `text` 字段，结果里也不再有 `details`/`content` 文本。

### Requirement: 输出统一截断

**Reason**: gh 工具不再交给 pi，没有面向模型的文本输出，2000 行 / 50KB 的文本预算无处施加；结构化载荷一贯给全量。

**Migration**: 需要控制上下文大小时由 codemode 脚本自行投影（`text(value)` 只输出需要的部分）；落盘的 CI 日志与 release 资产本来就不经预算。

### Requirement: release 与仓库文本工具的输出

**Reason**: 文本渲染契约消失：`list-github-releases` / `read-github-release` / `read-github-repo` 只返回结构化载荷，渲染器与文本格式不再是对外契约。

**Migration**: 需要 release 列表 / 详情 / 仓库概览的字段时，直接读结构化载荷里的 REST JSON（字段名与 REST 一致）。
