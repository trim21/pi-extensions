# Tasks

## 1. 列表与文本渲染

- [x] 1.1 `src/lib/github.ts`：`normalizeGhList`（gh GraphQL 列表 → `SearchHit`）与导出的 `dateOnly`
- [x] 1.2 `src/gh/base.ts`：`browseList`（`--json`）与 `renderHitList`（两条分支共用）
- [x] 1.3 `list-github-issues` / `list-github-prs` 改用两条分支归一后的记录与统一渲染，带载荷
- [x] 1.4 `src/gh/render.ts`：release / run / repo / release-detail 渲染器
- [x] 1.5 `list-github-releases` / `list-github-workflow-runs` / `read-github-repo` / `read-github-release` 改走 `--json`
- [x] 1.6 `read-github-pr-diff`：`parseDiffStats` 解析同一份 diff
- [x] 1.7 `watch-github-run`：收尾补 `gh run view --json`

## 2. schema 与文档

- [x] 2.1 `src/gh/schemas.ts`：8 个新载荷 schema
- [x] 2.2 README 的工具表与 AGENTS 的相关描述（若措辞受影响）
- [x] 2.3 openspec change（本目录）与主 spec 的 Implementation 段落

## 3. 测试与验证

- [x] 3.1 `test/gh-render.test.ts`：渲染器 + diff 解析（含重命名、删除、二进制）
- [x] 3.2 `test/gh-browse-list.test.ts`：浏览分支的文本 + 载荷、`fields`、`merged` 推断、搜索分支载荷
- [x] 3.3 `pnpm check` / `pnpm lint` / `pnpm test`
- [x] 3.4 `openspec validate gh-structured-text-tools --strict`
