# Proposal

## Why

带 `limit` 的 gh 列表工具（issue / PR / release / workflow run）用 `octokit.paginate` 取数，而 `paginate` 会顺着 `Link: rel="next"` 一直翻到最后一页才返回；`limit` 只在客户端 `slice` 截断。仓库历史越长，一次 `limit=20` 的调用发出的请求越多（几千个 run 就是几十次 HTTP 请求），拿回的绝大多数数据当场被丢弃，既慢又消耗 API 配额。

## What Changes

- `src/lib/github-reads.ts` 的分页列表取数改为「凑满 limit 就停止翻页」：每页 `per_page` 取 limit（≤100，`limitOf` 已 clamp），累计到 limit 条命中项后立即返回，不再请求后续页。
- 覆盖四个带 limit 的列表读取：`listIssues`（客户端滤掉 PR 后计数）、`listPulls`、`listReleases`、`listRuns`。
- 对外行为不变：仍是「最多 limit 条」，issues 列表仍滤掉混在响应里的 PR，过滤与排序仍由 GitHub 服务端决定；`limit` 的默认值与上限也不变。
- **不改**全量语义的取数：issue/PR comments、reviews、workflow run 的全部 job、check runs / suites 仍用 `octokit.paginate` 跟随 Link 翻完所有页（`get-github-workflow-jobs` 的「job 数超单页也必须全部返回」不受影响）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `gh-readonly`: 新增 requirement，规定带 `limit` 的列表取数在凑满 limit 后 MUST 停止翻页，而不是取完全部再截断；全量语义的列表取数不受影响。

## Impact

- 代码：`src/lib/github-reads.ts`（新增分页辅助函数，改写四个列表方法）。
- 测试：`test/github-reads.test.ts`（断言请求页数：凑满即停、需要翻页时继续、取尽不足 limit 时正常返回）。
- 不变：工具层（`src/gh/tools/list-*.ts`）、结构化载荷形状、渲染、`limit` 默认值与 clamp、错误契约。
- 对 GitHub 的请求模式变化：大仓库上列表调用从「翻完全部历史」变成「一到两页」，请求数下降。
