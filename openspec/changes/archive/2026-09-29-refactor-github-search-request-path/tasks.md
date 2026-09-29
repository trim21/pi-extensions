# Tasks

## 1. 代码

- [x] 1.1 `src/lib/github.ts` 的 `createGithubSearch.search`：删除 `@me` 展开（`getAuthenticated` 调用、`effective.assignee` 改写、`effective` 变量），`buildSearchQuery(kind, { ...params, limit })` 留在 `try` 内，`search.issuesAndPullRequests` 移入 `api.call` 回调并返回归一化结果。验证：`tsc --noEmit`。
- [x] 1.2 确认 `GithubApi` 接口注释（`call` 的语义）与实现一致，不需要额外改动；`grep -rn getAuthenticated src/` 为空。

## 2. 测试

- [x] 2.1 `test/github-search.test.ts` 新增两个用例（自建 401 后 200 的 fetch 序列，`token: async () => "test-token"`，不触网）：
  - 「缓存的 token 失效时换新 token 重试一次」：断言结果条数与 fetch 调用数（2）。
  - 「带关键词的搜索不展开 @me」：断言 fetch 调用数为 1 且请求 URL 含字面量 `assignee:@me`。
- [x] 2.2 回归证据：把 `createGithubSearch` 临时复原成旧实现，两个用例都失败——第一个抛 `GithubSearchError: GitHub auth failed (401): token invalid or expired — run "gh auth login": Bad credentials`（401 直接漏给调用方，没有重试），第二个 `AssertionError: expected [ 'https://api.github.com/user', …(1) ] to have a length of 1 but got 2`（多出的 `/user` 就是 `getAuthenticated`）。复原实现后两个用例通过。
- [x] 2.3 `node_modules/.bin/vitest run test/github-search.test.ts test/gh-readonly-list.test.ts test/pr-status.test.ts` 通过（26 passed）；`pnpm test` 全套通过（82 files / 1247 passed / 6 skipped）。

### 调查记录：/search 路由的 2s 节流

两个新用例各约 2s，排查后确认**与本次改动无关**：`octokit` v5 的 `Octokit` 类在 `.defaults()` 里默认启用 `@octokit/plugin-throttling`，实测同一进程内第二次请求 `/search` 路由要等 ~2s（换成 `/repos` 路由则 0ms；`retry`/`throttle` 都关掉后也为 0ms）。这与 GitHub 搜索 API 的 30 req/min 一致，属于既有生产行为（`createGithubApi` 每实例缓存一个 client，重复搜索会被客户端排队）。已在测试里加注释说明，避免后来者重复排查。

## 3. 收尾

- [x] 3.1 `prettier --write`（并用 `Response.json` 替掉 `new Response(JSON.stringify(...))`、去掉多余的 fetch 断言以满足 lint），`pnpm check` 与 `pnpm lint` 全绿（exit 0）。diff（`git diff --numstat HEAD`）：`src/lib/github.ts`（+9/-13）、`test/github-search.test.ts`（+82/-1）、`openspec/specs/gh-readonly/spec.md`（+1/-1，Purpose 补关键词搜索例外），外加 change 目录。
- [x] 3.2 归档 change；确认 `openspec/specs/gh-readonly/spec.md` 的「issue 与 PR 查询」requirement 已按 delta 更新（新增两个场景，描述 octokit 路径与不展开 `@me`）。
- [x] 3.3 报告：行为变化（带关键词 + `assignee: "@me"` 从展开变为字面量，无关键词路径不变）、未做项（工具参数描述仍写 `(@me for yourself)`、`GhClient` 两份 client/token 缓存、两处 transport 选择的原因只写进了 spec 的 requirement 未写进代码注释）。
