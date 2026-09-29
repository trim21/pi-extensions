# Proposal

## Why

`createGithubSearch`（`src/lib/github.ts:307-336`）用 `api.call` 只做了「取 client 并发一个额外请求」——为了把用户输入的 `@me` 展开成 login——真正的 `search.issuesAndPullRequests` 在 `api.call` **之外**发出。于是 `GithubApi` 在接口注释里承诺的「client 与 token 缓存 + 401 时丢缓存重试一次」不覆盖搜索路径，而同一个 `GhClient` 上的 checks 路径（`createGithubChecks`）每个请求都在 `call` 里：token 过期或在另一个终端重新 `gh auth login` 之后，checks 轮询会自动换 token 重试成功，搜索一直 401 失败到重启 pi。

`@me` 展开本身是 **gh CLI 的简写**（gh 的 `--assignee "@me"` 由 gh 自己展开），REST 搜索 API 不认识它。用户决定：SDK 路径不需要支持 `@me`（gh CLI 路径支持算加分项）。删掉这个展开之后，`search()` 里只剩「拼查询串 + 发一次请求」，两条诉求同时满足。

## What Changes

- 删除 `createGithubSearch.search` 里的 `@me` 展开（`client.rest.users.getAuthenticated()` 调用与 `effective.assignee` 改写、`effective` 变量），搜索请求整体进入 `api.call` 回调。
- `buildSearchQuery` 仍在 `try` 内调用，错误包装（`GithubSearchError`）与报文不变。
- gh CLI 路径不动：`listGithubArgs` 照旧把 `--assignee @me` 原样传给 `gh`，由 gh 展开。
- `openspec/specs/gh-readonly/spec.md`：在「issue 与 PR 查询」requirement 下补一个场景，写明带关键词的搜索走 octokit、`@me` 只在 gh CLI 路径由 gh 展开；Purpose 里「issue / PR 查询以 gh CLI 为后端」那句话补上关键词搜索这一例外。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `gh-readonly`：issue / PR 查询的传输与 `@me` 边界（行为变化：带关键词的搜索不再展开 `@me`）。

## Impact

- 代码：`src/lib/github.ts`（`createGithubSearch`，约 -8/+4 行）。
- 测试：`test/github-search.test.ts` 新增两个用例——401 丢缓存重试一次对搜索生效（旧实现下失败）、带关键词的搜索不触发 `getAuthenticated` 且 `q` 里保留字面量 `@me`（旧实现下失败）。既有纯函数用例不变。
- 行为变化（用户可见）：`assignee: "@me"` 在**带关键词**的搜索里不再被展开，会作为字面量进入查询串（GitHub 会给出空结果）；**不带关键词**时仍走 gh CLI，`@me` 照旧可用。工具参数描述里的 `(@me for yourself)` 因此只对无关键词路径成立——本次不动描述，风险见 design.md。
- 不涉及依赖、配置格式、其它工具；`GhClient` 里两个 octokit 实例（各带一份 client/token 缓存）是另一个待办，不在本 change 范围。
