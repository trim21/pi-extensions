# Proposal

## Why

`list-github-issues` / `list-github-prs` 的 `assignee` 参数写着「@me for yourself」，`author` 没写；而内部对 `@me` 机制的记录（`openspec/specs/gh-readonly/spec.md` 的「issue 与 PR 查询」）把它描述成「`gh` 的简写、octokit 路径不认识」——这个说法不成立：`@me` 由 GitHub 的搜索 / 过滤 API 解析，两条传输都把字面量交给它。所以 `author` / `assignee` 在**两条路径上都支持** `@me`，描述应当一致地把这件事写清楚。

证据（离线从 gh 源码镜像 `/srv/ssd-1/projects/github/cli/cli` 得到）：

- `gh search issues --assignee=@me`、`gh search prs --assignee=@me`、`gh search prs --review-requested=@me` 是 gh 自己 help 里的示例（`pkg/cmd/search/issues/issues.go:67`、`pkg/cmd/search/prs/prs.go:59,62`），`pkg/cmd/search/` 里没有任何 `@me` 展开代码，这些请求发到 REST 搜索 API（`pkg/search/searcher.go:206` 指向 REST 搜索文档）。
- `gh pr list --author "@me"`（gh help 示例，`pkg/cmd/pr/list/list.go:64`）必然走该命令的搜索分支——`pkg/cmd/pr/list/http.go:13` 的 `shouldUseSearch` 只要 `Author` / `Assignee` 非空就返回 true——同样不展开 `@me`。
- gh 只在 GraphQL 过滤路径自行展开 `@me`：`pkg/cmd/pr/shared/params.go:284` 的 `MeReplacer`，用点是 issue list 的非搜索分支（`pkg/cmd/issue/list/list.go:248`）与 create / edit。

本仓库两条传输的落点：不带 `keywords` 时 `gh issue list` / `gh pr list`（`src/gh/tools/list-issues.ts:18`、`list-prs.ts:18`），带 `keywords` 时 octokit 的 REST 搜索（`src/lib/github.ts` 的 `createGithubSearch`，2026-09-29 起不再自行展开 `@me`）。

## What Changes

- `src/gh/tools/list-issues.ts` / `src/gh/tools/list-prs.ts`：`author` 与 `assignee` 的描述统一为 `Filter by author ('@me' for yourself)` / `Filter by assignee ('@me' for yourself)`；各加一行注释记录「两条传输都支持 `@me`、由搜索 / 过滤 API 解析、不要在本仓库再实现一次展开」，避免后人重新加回 `getAuthenticated()` 展开。
- `openspec/specs/gh-readonly/spec.md`：「issue 与 PR 查询」requirement 与场景里对 `@me` 的说法改为「由搜索 / 过滤 API 解析，本仓库两条传输都按字面量转发，客户端不展开」。
- 不改代码行为、不改测试断言（没有测试断言这些描述）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `gh-readonly`：`author` / `assignee` 的 `@me` 语义文档化（工具参数描述 + requirement 措辞修正）。行为无变化——`@me` 在改动前后都能用，改的只是描述与 spec 说法。

## Impact

- 代码：`src/gh/tools/list-issues.ts`、`src/gh/tools/list-prs.ts`（仅 schema 描述与注释）。
- 测试：无。`test/gh-readonly-list.test.ts` 只断言 `@me` 原样出现在 `gh` 的 argv 里（`--assignee @me`），不受描述文本影响。
- 未做：没有为「关键词 + `@me`」加端到端断言（要验证需要真实网络与登录；沙箱里 `gh` / `web_fetch` 都不通）。
