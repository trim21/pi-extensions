# gh-readonly 规格变更

## MODIFIED Requirements

### Requirement: issue 与 PR 查询

查询 issue / PR 详情与列表。不带关键词的列表走系统 `gh` CLI（`gh issue list` / `gh pr list`），带关键词的搜索走 octokit（`gh issue list --search` 的 state 默认 open 会漏 closed / merged）。`@me` 是 `gh` CLI 的简写（由 `gh` 自己展开成当前登录用户），octokit 路径 MUST NOT 维护 `@me` 展开：带关键词的搜索里它按字面量进入查询串。

#### Scenario: 按编号查询详情

- **WHEN** 指定 repo 与编号查询 issue 或 PR
- **THEN** 返回结构化详情（标题、状态、正文、作者、时间、labels、assignees、comments 等；PR 含变更统计与 reviews）

#### Scenario: 列表与跨仓库搜索

- **WHEN** 指定 repo 列出 issue / PR（支持 state / label / author / assignee / milestone / limit 过滤）
- **THEN** 返回列表；未指定 repo 且带关键词时退化为跨 GitHub 搜索（不拼接 `repo:` 限定符，避免 gh 误解析）

#### Scenario: 带关键词的搜索走 octokit 且不做 @me 展开

- **WHEN** 带关键词（或带 `@me` 之外需要 octokit 语义的过滤条件）查询 issue / PR
- **THEN** 请求经 octokit 发出，且每个请求都在带 client 缓存与「401 丢缓存重试一次」的调用路径内：缓存的 token 失效时自动换新 token 重试一次，而不是直接失败
- **WHEN** `assignee` 传 `@me` 且带关键词
- **THEN** 查询串里保留字面量 `assignee:@me`，不发起 `users.getAuthenticated` 请求（该写法在 octokit 路径上不展开；不带关键词时仍由 `gh` 展开）
