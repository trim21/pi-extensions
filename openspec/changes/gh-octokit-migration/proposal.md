# gh 工具改走 octokit，不再依赖 gh CLI 的 I/O

## Why

gh 工具现在有 18 处 `spawn("gh", …)`（12 处 `gh … --json`、2 处 `gh api`、4 处只有 CLI 能做）。这条路径的代价：

- **多一层进程与一层过滤**：每个工具启动一个 gh 子进程，拿到的 JSON 是 gh 自己挑字段后的结果，字段名（GraphQL camelCase）与 GitHub REST（下划线）不一致，于是同一份数据在仓库里有两套形状，schema 得写成并集。
- **两个请求都过的代理/超时/中止配置**：`runGh` 单独注入代理变量、超时、SIGTERM→SIGKILL，而 octokit 走 `src/lib/egress.ts`，是另一套。
- **`isGhAvailable()` 决定注册**：机器上没装 gh 就一个 gh 工具都不注册，哪怕有 `GH_TOKEN`。
- **CLI 的隐式行为混进数据**：`--paginate --slurp`、`@me` 展开、`gh release download` 的 `--skip-existing` / `--archive` / pattern 匹配都在 gh 里，我们只拿到结果。

octokit 客户端（`src/lib/github.ts`）已经在跑：关键词搜索、checks、job 列表与 job 元数据。这次把剩下的读路径也搬过去，让「GitHub 数据」只有一条通路。

## What Changes

- **删掉 `gh … --json` 这一类（12 处）**，改用 octokit 的 REST 端点：issue/PR/comments/release/workflow run/repo 的读取全部走 REST，`--paginate --slurp` 由 `octokit.paginate` 取代。工具输出的 JSON 直接是 **REST 原物**（`html_url` / `closed_at` / `user.login` / `labels[].name`），不再逐字段改名——现有 schema 本来就是 GraphQL+REST 并集，正好收窄成 REST 一套。
- **`gh api` 那两处（`ghApiList`、CI 日志）**：前者换成 `pulls.listReviews`；后者换成 `actions.downloadJobLogsForWorkflowRun`（octokit 跟 302 取回日志文本，仍原样落盘）。
- **CLI 独有能力的替代方案**：
  - `gh pr diff` → `pulls.get` 带 `mediaType: { format: "diff" }`；
  - `gh run watch` → 轮询 `actions.getWorkflowRun`（沿用现有 wait 工具的轮询风格与 `onUpdate` 进度），文本不再是 gh 的过程输出；
  - `gh release download` → `releases.getReleaseByTag`（资产清单）+ `repos.getReleaseAsset` 流式落盘；`--pattern` 由我们自己按 glob 匹配、`--skip-existing` 由「同名文件已在且大小一致就跳过」承担；`--archive` 用 `repos.downloadZipballArchive` / `downloadTarballArchive`。
- **认证、注册门控与 repo 解析都不动**：token 仍由 `gh auth token` 提供（每进程缓存一次，首次建客户端时惰性获取），注册门控仍是 `isGhAvailable()`（PATH 里有 gh），`resolveRepo` 仍是 `gh repo view --json nameWithOwner`。`ghExec` / `GhError` / `runGh` 因此保留（认证与 repo 解析还在用），只是不再是取数据的通道。
- **repo 缺省仍由 gh 解析**：「当前仓库」继续用 `gh repo view --json nameWithOwner`（`resolveRepo` 不动）——这条不是取数据，用 gh 解析反而更省事、也更准（worktree / submodule / 多层目录都归 gh 管）。迁移动的是**取数据**的路径。
- **`@me` 不再展开**：只有关键词搜索路径保留 `@me`（搜索 API 自己解析字面量），浏览路径的 `author` / `assignee` 按字面量传给 REST，`@me` 不再被展开——工具描述与 spec 同步说明。

## Impact

破坏性变更（都是工具输出层面，签名不变）：

- 工具输出的 JSON 字段名从 gh 的 GraphQL 形状变成 REST 形状。
- 浏览列表不再支持 `@me`（关键词搜索仍然支持）。
- `watch-github-run` 的文本不再是 `gh run watch` 的过程输出，改成状态轮询进度 + 完成报告。
- `list-github-workflow-runs` 的 `workflow` 过滤改成「先按名字/文件名找到 workflow id，再列它的 run」。
- 错误消息从 `GhError`（argv + 输出上下文）变成 octokit 的 HTTP 错误（含 status 与请求路径）。

## Out of Scope

- `gh auth token` 这一处 gh 子进程（用户明确保留）。
- octokit 的 GraphQL 端点：REST 够用，且 REST 字段名已经是现有 schema 的另一半。
- 工具的参数列表：除 `@me` 语义外不改（`fields`、`limit`、`pattern`、`archive` 都保留）。
