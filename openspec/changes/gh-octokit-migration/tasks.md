# Tasks

## 1. 共享层

- [x] 1.1 `src/lib/github.ts`：`createGithubApi` 导出并加 `rawFetch`（二进制/归档下载 + 401 重试 + token 单点缓存）
- [x] 1.2 `src/lib/github-reads.ts`（新）：REST 读取客户端（issues / pulls / comments / reviews / releases / workflow runs / jobs / repo / 资产与归档下载）
- [x] 1.3 `GhClient` 注入 `reads`；`src/gh/base.ts` 的 `browseList` 换成 REST 列表 + REST 归一化
- [x] 1.4 删除取数据用的 `ghExec` 调用点与 `ghApiList` / `listGithubArgs` / `GH_LIST_FIELDS` / `normalizeGhList`；保留 `runGh` / `ghAuthToken` / `resolveRepo` / `isGhAvailable`

## 2. 工具迁移

- [x] 2.1 `read-issue` / `read-pr`（`reviews` / `comments` 另调）
- [x] 2.2 `read-issue-comments` / `read-pr-comments`（含 `reviews=true` 分支：`pullReviews` + `pullReviewComments`）
- [x] 2.3 `list-issues` / `list-prs`（两条分支都归一，浏览不再依赖 gh）
- [x] 2.4 `read-github-pr-status` / `wait-pr-checks` / `wait-commit-checks`（headRefOid 走 `pulls.get`）
- [x] 2.5 `list-releases` / `read-release` / `download-release-assets`（glob pattern 用 `path.matchesGlob`、archive、skip-existing 改成「同名同大小」）
- [x] 2.6 `list-workflow-runs`（`workflow` 名 → id 解析）/ `get-workflow-jobs`（原本就走 octokit）
- [x] 2.7 `read-ci-logs`（`downloadJobLogsForWorkflowRun` + 原样落盘）
- [x] 2.8 `read-pr-diff`（diff media type + 同一份 diff 解析统计）
- [x] 2.9 `watch-run`（`base.ts` 的 `watchRun` 轮询 `getWorkflowRun` + onUpdate 进度 + 30s/600s）
- [x] 2.10 `read-repo`（`repos.get`）

## 3. 文档与 schema

- [x] 3.1 `src/gh/schemas.ts`：注释与并集字段收窄（GraphQL 形状的字段可以删）
- [ ] 3.2 `openspec/specs/gh-readonly/spec.md` 的 Implementation 段（归档时合）
- [x] 3.3 README / AGENTS 里关于 gh CLI 的措辞

## 4. 测试

- [x] 4.1 删掉 argv 断言的测试（`gh-process` / `listGithubArgs` / `releaseDownloadArgs` 相关）
- [x] 4.2 用 `test/github-fixtures.ts` 的 cassette 覆盖迁移后的每个端点（新录必要时 `RECORD_GITHUB=1`）
- [x] 4.3 纯函数单测：`.git/config` 解析、release pattern glob、archive 命名、run 轮询判定
- [x] 4.4 `pnpm check` / `pnpm lint` / `pnpm test` 全绿（1390 passed / 6 skipped）

## 5. 验证

- [x] 5.1 真机手测：`read-github-issue` / `list-github-prs` / `read-github-ci-logs` / `download-github-release-assets` / `watch-github-run`
- [x] 5.2 `openspec validate gh-octokit-migration --strict`
