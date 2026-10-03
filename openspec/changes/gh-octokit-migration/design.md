# Design

## D1：认证与注册门控都不动

认证的替代方案有三条：只认 `GH_TOKEN` / `GITHUB_TOKEN` 环境变量（干净但会让只用 `gh auth login` 的本地用户直接不可用）、读 gh 的凭据文件 `~/.config/gh/hosts.yml`（需要 YAML 解析 + 校验，且 gh 的存储格式不是稳定接口）、保留 `gh auth token` 子进程（每进程缓存一次）。用户选择保留子进程：`src/lib/gh-process.ts` 因此从「所有 I/O 的通道」缩成「认证用的一个小工具」。

注册门控同样不变：仍是 `isGhAvailable()`（PATH 里有 gh）。不改成探测 token 的理由是探测要 spawn 一次 `gh auth token`，把注册变成有副作用的慢路径；没登录这类失败本来就会在首次调用时报出清晰错误。

## D2：字段形状给 REST 原物

现在有两套形状：关键词搜索走 REST（`html_url` / `closed_at` / `user.login`），`gh … --json` 走 GraphQL（`url` / `closedAt` / `author`）。仓库为此把 schema 写成并集，`ghCommentSchema` / `ghReviewSchema` 的注释就写着「GraphQL 与 REST 的并集」。

迁移后统一到 REST，schema 可以收窄成一套（本次不强制收窄，避免 schema 变更与迁移混在一个 diff 里，但注释要改）。代价是工具输出的 JSON 文本与 `details` 里的字段名变了：这是模型可见的契约变更，写进 proposal 的破坏性变更清单。

## D3：repo 缺省继续用 gh 解析

`resolveRepo` 保持 `gh repo view --json nameWithOwner` 不变。用户明确：用 gh 获得「当前是哪个仓库」可以接受，本次迁移的目标只是不再用 gh **取数据**。这也省掉一套 `.git`/git config 解析（worktree、submodule、多层目录、非 GitHub 主机这些情况 gh 都处理好了）。

因此 `ghExec` / `GhError` / `runGh` 都保留（`ghAuthToken` 与 `resolveRepo` 还在用），删除的只有那些「用 gh 取业务数据」的调用点。

## D4：端点映射

| 现在                                                 | 迁移后                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh repo view --json nameWithOwner`（`resolveRepo`） | 不动（D3）                                                                                                                                                                                                                              |
| `gh issue view --json …`                             | `issues.get`                                                                                                                                                                                                                            |
| `gh pr view --json …`                                | `pulls.get`（`reviews` / `comments` 另调 `pulls.listReviews` / `issues.listComments`）                                                                                                                                                  |
| `gh issue view --json comments`                      | `issues.listComments`（`paginate`）                                                                                                                                                                                                     |
| `gh pr view --json comments`                         | `pulls.listReviewComments`（`paginate`；`includeComments` 时并 `issues.listComments`）                                                                                                                                                  |
| `gh issue list --json …` / `gh pr list --json …`     | `issues.listForRepo` / `pulls.list`（`state` / `labels` / `assignee` / `creator` / `milestone` / `per_page`；`@me` 不展开）                                                                                                             |
| `gh pr view --json headRefOid`                       | `pulls.get`                                                                                                                                                                                                                             |
| `gh pr diff`                                         | `pulls.get` + `mediaType: { format: "diff" }`                                                                                                                                                                                           |
| `gh release list --json …`                           | `releases.listReleases`                                                                                                                                                                                                                 |
| `gh release view --json …`                           | `releases.getReleaseByTag`（缺 tag 走 `getLatestRelease`）                                                                                                                                                                              |
| `gh run list --json …`                               | `actions.listWorkflowRunsForRepo`（`workflow` 先经 `actions.listRepoWorkflows` 解析成 id）                                                                                                                                              |
| `gh run view --json …`                               | `actions.getWorkflowRun`                                                                                                                                                                                                                |
| `gh run watch`                                       | 轮询 `actions.getWorkflowRun`（间隔沿用 wait 工具的 30s、上限 600s，`onUpdate` 报状态）                                                                                                                                                 |
| `gh api /repos/…/jobs/<id>/logs`                     | `actions.downloadJobLogsForWorkflowRun`                                                                                                                                                                                                 |
| `gh api --paginate --slurp <path>`（reviews）        | `pulls.listReviews`（`paginate`）                                                                                                                                                                                                       |
| `gh release download …`                              | 读层 `downloadAssetTo`（`getReleaseAsset` + `Accept: application/octet-stream` 流式落盘）；`--archive` 走仓库 zipball / tarball 端点；`--pattern` 自己用 `node:path.matchesGlob` 匹配资产名；`--skip-existing` 改成「同名且字节数一致」 |
| `gh auth token`                                      | 保留（D1）                                                                                                                                                                                                                              |

## D5：`gh release download` 的重实现要点

- `--skip-existing` 的现有语义（README/spec）：**目录里已存在的文件保留，不再重新下载**。迁移后按「同名且大小一致 → 跳过，否则下载覆盖」实现，比 gh 的「存在即跳过」更准（避免半截文件被当成已完成）。
- `--pattern` 是逗号分隔的多个 glob，匹配的是 release 的资产名；未命中时工具会给出可选资产名（现有行为，保留）。
- `--archive` 下 gh 下载的是**仓库源码归档**（不是资产），因此命名与 `.zip` / `.tar.gz` 后处理都按 octokit 的两个归档端点来。

## D6：错误契约

`GhError` 带着 argv、退出码与 stderr 片段。迁移后错误来自 octokit（`RequestError`：status、url、message）。工具的错误文案因此变成「HTTP 状态 + 请求路径 + GitHub 的 message」，README/spec 里的「命令失败契约」段随之改写。超时/中止仍由调用方的 `signal` 表达（octokit 支持 `request.signal`），`runGh` 的超时/SIGKILL 逻辑只剩 `ghAuthToken` 一处使用。

## D7：测试策略

- **HTTP 层**：`test/github-fixtures.ts` 的 cassette（按 URL 路由回放 fixture，可用 `RECORD_GITHUB=1` 真录）覆盖迁移后的每个端点；调用方（工具）在测试里注入 cassette 的 `fetch`，因此不需要网络与 token。
- **纯函数**：release pattern glob 匹配、`--archive` 命名、run 状态轮询的判定、REST 列表归一化，都做成纯函数单测。
- **删掉的测试**：`listGithubArgs` / `releaseDownloadArgs` / `gh-process` 的 argv 断言随实现一起删除或改写。
- 迁移不改变工具的 `structuredSchema` 语义（仍是「与文本同源 + 全部条目」），因此 codemode 侧零改动。

## D8：分步实施

一次改 18 处会变成一个没法 review 的 diff。按「共享层 → 每组工具 → 删 gh 路径」推：

1. `src/lib/github.ts`：补齐 REST 客户端（新增各端点的薄封装 + `paginate` 用法）。
2. `src/gh/base.ts`：换掉 `resolveRepo` / `browseList` / `ghExec` / `isGhAvailable`，保留 `toToolResult` / `withStructuredResult` / pendant / 截断。
3. 逐个工具迁移（issue/PR → comments → releases → runs → ci-logs → diff → download → watch）。
4. 删除 `ghExec` / `GhError` / argv 组装 / `normalizeGhList` / `GH_LIST_FIELDS`，`gh-process.ts` 缩到只剩 `runGh` + `ghAuthToken`。
5. 收尾：spec/README/AGENTS 措辞、schema 注释、全量测试。

## D5：实施中与计划不同的地方

- **`rawFetch` 与单点 token 缓存**：二进制与归档下载不能走 octokit（它会把响应体按 JSON 解析），于是 `createGithubApi` 导出并加了 `rawFetch`——同一个 token、跟随重定向、401 时丢掉缓存 client 重试一次。它逼出了另一件事：token 从「client 内部隐式缓存」提成闭包里的单点缓存（否则每次原始请求都会 spawn 一次 `gh auth token`）。
- **`.git/config` 解析器删掉了**：计划里 D3 曾打算自己解析 `remote.origin.url`（写过 `src/gh/repo-path.ts` 与 9 个单测），用户澄清「用 gh 解析当前仓库可以，只是不用 gh 取数据」后整块删除，`resolveRepo` 保持原样。
- **glob 用 Node 标准库**：`node:path.matchesGlob`（Node ≥ 22.5，本项目要求 ≥ 24）覆盖 `*` / `?` / `[...]`，不必引入 minimatch。
- **归档文件由我们命名**：`<repo>-<tag>.zip` / `.tar.gz`（gh 用的是 `<owner>-<repo>-<tag>`），名字进了工具输出与 `details`，所以写在 spec delta 里。
- **`watchRun` / `renderRunStatus` 落在 `src/gh/base.ts`**：与既有的 `pollPrChecks` / `renderPrChecksList` 并列，保持「等待与渲染是纯函数 + 可在测试里注入 interval/deadline」的既有结构。
- **REST 归一化放在 `src/lib/github.ts`**：`normalizeRestList` 与既有的 `renderHits` / `SearchHit` 同处，让搜索结果与浏览结果共用一套记录与渲染。
- **`read-github-pr-comments` 的 `reviews=true`**：REST 里行内评审评论是 `pulls.listReviewComments`、评审摘要是 `pulls.listReviews`，两者都要（原来 `gh api` 也是两次请求）。
- **`get-github-workflow-jobs` / `read-github-pr-status` / 两个 `wait-*` 未动**：它们本来就跑在 octokit 上。
