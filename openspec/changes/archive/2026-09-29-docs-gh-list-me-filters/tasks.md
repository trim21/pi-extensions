# Tasks

## 1. 描述

- [x] 1.1 `src/gh/tools/list-issues.ts`：`author` 改为 `Filter by author ('@me' for yourself)`，`assignee` 保持同措辞；在两者上方加注释说明「`@me` 由 GitHub 的搜索 / 过滤 API 解析，`gh` 与 octokit 两条传输都支持，本仓库不要再实现一次展开」。
- [x] 1.2 `src/gh/tools/list-prs.ts`：同上（两处 schema 逐字一致）。
- [x] 1.3 确认工具集里只有这两个工具带 user 类过滤参数：`grep -n "author\|assignee" src/gh/tools/*.ts` 只应命中这两个文件（`read-issue.ts` / `read-pr.ts` 里的 `author` / `assignees` 是输出列名，不是过滤参数）。

## 2. spec

- [x] 2.1 `openspec/changes/docs-gh-list-me-filters/specs/gh-readonly/spec.md` 的 MODIFIED requirement 含完整的三条场景（按编号查询详情 / 列表与跨仓库搜索 / 带关键词的搜索走 octokit 且不做 @me 展开），只修正 `@me` 的说法；归档后确认 `openspec/specs/gh-readonly/spec.md` 未出现重复场景。

## 3. 验证

- [x] 3.1 `node_modules/.bin/prettier --write src/gh/tools/list-issues.ts src/gh/tools/list-prs.ts`；`pnpm check` 与 `pnpm lint` 全绿。
- [x] 3.2 `node_modules/.bin/vitest run test/gh-readonly-list.test.ts test/github-search.test.ts` 通过；`pnpm test` 全套通过（描述文本没有测试断言，预期与改动前同样的用例数）。
- [x] 3.3 归档 change 并报告：改动内容、证据链（gh 源码位置）、未做项（无网络，未对「关键词 + `@me`」做端到端实测）。
