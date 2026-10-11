# Tasks

## 1. 取数层改造

- [x] 1.1 在 `src/lib/github-reads.ts` 增加私有 helper `takePages(fetchPage, limit, accept)`：逐页请求 `page` 递增，按 `accept` 收集条目，凑满 limit 或本页条目数不足 `per_page` 时返回
- [x] 1.2 改写 `listIssues`：在 `api.call` 内用 `takePages`，`accept` 过滤掉带 `pull_request` 的条目
- [x] 1.3 改写 `listPulls`、`listReleases`、`listRuns` 改用 `takePages`（`listRuns` 保留 workflow id 解析与 `status` 参数）

## 2. 测试

- [x] 2.1 在 `test/github-reads.test.ts` 断言「凑满 limit 即停止」：条目多于 limit 时只请求一页（`calls.length === 1`）
- [x] 2.2 断言「列表取尽不足 limit」：条目少于 limit 时返回全部且只请求一页
- [x] 2.3 断言 issues 列表过滤 PR 后仍凑满 limit，且不足时需要翻页（按 page 参数区分路由）

## 3. 验证

- [x] 3.1 运行 `pnpm test`（至少 `test/github-reads.test.ts`、`test/gh-tools-rest.test.ts`）
- [x] 3.2 运行 `pnpm check` 与 `pnpm lint`
- [x] 3.3 检查 diff，确认没有调试代码与无关改动

## Workflow follow-up

- 归档 change（`/openspec-archive-change`），把 delta 合入 `openspec/specs/gh-readonly/spec.md`
