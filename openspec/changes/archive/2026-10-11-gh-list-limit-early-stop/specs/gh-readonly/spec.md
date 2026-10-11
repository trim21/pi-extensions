# Spec Delta

## ADDED Requirements

### Requirement: 列表取数凑满 limit 即停止翻页

带 `limit` 的列表工具（`list-github-issues`、`list-github-prs`、`list-github-releases`、`list-github-workflow-runs`）MUST 在取到 limit 条命中项后立即停止向 GitHub 请求后续页，MUST NOT 取完整个列表再在客户端截断。每页 `per_page` MUST 取 limit（上限 100）。需要客户端过滤的列表 MUST 按过滤后的条数计数。

#### Scenario: 凑满 limit 就停止请求

- **WHEN** 仓库的 issue / PR / release / workflow run 数量远多于 `limit`
- **THEN** 只请求凑满 limit 所需的最少页数，其后不再发出请求，返回条数为 limit

#### Scenario: 客户端过滤后计数

- **WHEN** 列出 issue，而 REST `issues.listForRepo` 的响应里混着 PR
- **THEN** 过滤掉 PR 后才计入 limit，凑不满时继续请求下一页，返回的条目全部是 issue

#### Scenario: 列表取尽不足 limit

- **WHEN** 列表剩余条目少于 limit
- **THEN** 返回已取到的全部条目，不报错

#### Scenario: 全量列表不受影响

- **WHEN** 读取 issue / PR comments、reviews、workflow run 的全部 job 或 check runs
- **THEN** 仍跟随 Link 取完所有页，不因 limit 提前停止
