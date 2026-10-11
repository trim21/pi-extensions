# Design

## Context

见 proposal.md - Why。当前 `src/lib/github-reads.ts` 的四个带 limit 的列表方法都是 `octokit.paginate(...)` + `slice(0, limit)`；`GithubApi.call` 是唯一承载「401 丢缓存 token 重试一次」与 `GithubApiError` 包装的路径，绕过它的请求会丢掉这层保护。

## Goals / Non-Goals

**Goals:**

- 列表请求数由「列表总长度」变为「凑满 limit 所需页数」。
- 对外行为、`limit` 默认值与 clamp、错误契约、结构化载荷形状都不变。

**Non-Goals:**

- 不改工具层（`src/gh/tools/list-*.ts`）的参数与渲染。
- 不改全量语义的取数（comments / reviews / job / check 列表），它们仍用 `octokit.paginate`。
- 不引入新依赖、不调整 `limitOf` 的上限。

## Decisions

**手动 `page` 循环，而不是 `octokit.paginate.iterator`。** 两者都能做到边取边停，但 iterator 每次 `next()` 都是独立请求，若放在 `api.call` 回调之外，401 就失去「丢缓存重试一次」的处理；手写循环可以直接整段包在 `api.call(async (octokit) => ...)` 里，终止条件（凑满 limit / 本页不足 `per_page`）也一眼可见。

**`per_page` 取 limit（`limitOf` 已 clamp 到 1..100）。** 一次请求通常即满足；固定 `per_page: 100` 虽能进一步减少页数，但会把大量随即被丢弃的数据拉回本地。issues 列表有客户端过滤，条目密度低时页数会多一些，但仍以「凑满就停」为界。

**终止条件用「本页条目数 < `per_page`」而不是「本页为空」。** GitHub 列表端点最后一页不足 `per_page`，据此即可判定取尽，省掉一次必然为空的请求。

**过滤用谓词在计数前生效。** issues 端点响应混着 PR，helper 接收 `accept(item)`，只有命中的条目才计数并进入结果，因此 limit 语义仍是「最多 limit 条 issue」。

**抽一个私有 helper** `takePages(fetchPage, limit, accept)`，四个方法各自传 `(page) => Promise<T[]>`。

## Risks / Trade-offs

- [过滤率高时页数仍可能多] → 循环在列表取尽时自然结束，不额外请求；这是客户端过滤的固有成本，与改动前相比只少不多。
- [401 重试会重跑整个循环] → 重试只在第一次尝试时发生，重跑最多多几次请求；与改动前 `api.call` 包住单次 `paginate` 的语义差异可接受。
- [末页判定依赖 GitHub 返回条数] → 与 `octokit.paginate` 的 Link 语义一致；`per_page` 合法（≤100）时 GitHub 不会截断单页。
