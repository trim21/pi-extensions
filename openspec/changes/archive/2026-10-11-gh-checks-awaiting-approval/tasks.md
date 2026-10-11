# Tasks

## 1. 取数层（`src/lib/github.ts`）

- [x] 1.1 新增 `CheckSuite`（`id` / `appSlug` / `status` / `conclusion`）与 `WorkflowRunRef`（`id` / `checkSuiteId` / `name` / `event` / `htmlUrl` / `runStartedAt`）类型，并在 `GithubChecksClient` 上新增 `suites(owner, repo, ref, signal)`（`checks.listSuitesForRef`，`octokit.paginate` + `per_page: 100`）与 `workflowRuns(owner, repo, headSha, signal)`（`actions.listWorkflowRunsForRepo`，同样分页）；`checkRuns()` 内部那段 event 补齐删掉，`CheckRun` 去掉 `event` 字段、改用 `checkSuiteId`（取 `run.check_suite.id`）。验证：`pnpm check` 通过，`pnpm exec vitest run test/github-client-fetch.test.ts test/github-api.test.ts` 全绿
- [x] 1.2 录制新 fixture：以 `valkey-io/libvalkey-py#89`（head `6d8644d9`，6 个等待审批的 workflow、0 个对应 check run）为数据源，用 cassette 录下 pull / combined-status / check-runs / check-suites / workflow-runs 到 `test/fixtures/github/`（`awaiting-approval-*.json`），并为已存在的 `trim21/pi-extensions#137` 快照补录 `check-suites.json`（该快照的 head sha 早于当前，直接按 sha 取该端点的响应落盘，与既有四份 fixture 同源）。验证：`RECORD_GITHUB=1 pnpm exec vitest run test/pr-status.test.ts` 后 fixture 落盘，回放运行不发起真实请求且既有断言不变

## 2. 判定层（`src/gh/base.ts`、`src/gh/schemas.ts`）

- [x] 2.1 `CheckBucket` 增加 `"action_required"`；`checkRunBucket` 的 `action_required` 从 `skipped` 改判到新 bucket；新增 suite 的 bucket 映射；`MergedCheck` 增加 `suiteId`（check run 取 `checkSuiteId`，摊平出来的 suite 条目取自身 id，status 为 null）；`mergeChecks(statuses, checkRuns, suites, workflowRuns)` 增加两个入参，**只展开「已结束（`completed` 且 conclusion 非空）且没有任何 check run」的 suite**（adapter 预建的空壳 suite 必须忽略，否则 wait 永远超时），元数据按 `checkSuiteId` 匹配 workflow run，匹配不到时名字退化为 `appSlug`。验证：`test/wait-pr-checks.test.ts` 新增 mergeChecks 用例——孤儿 suite 成为独立条目且带 run 的名字/事件/链接与 `suiteId`、queued/in_progress 的孤儿 suite 被忽略、有 check run 的 suite 不产生额外条目（总数与旧行为一致）且其 check runs 带该 `suiteId`、bucket 映射（`action_required` / 未知值）、匹配不到 run 时用 app slug
- [x] 2.2 `pollPrChecks` 每轮并行取 statuses / checkRuns / suites（有 suite 或 check run 带 run id 时再取 workflow run 列表），出现 `action_required` 立即结束本轮等待并返回新的 outcome；`fail` 优先。验证：`test/wait-pr-checks.test.ts` 轮询用例——含 `action_required` 时只轮询一次就返回、同轮有 fail 时按 fail 返回、无 `action_required` 时既有超时/容错/多轮行为不变
- [x] 2.3 `renderChecksVerdict` 增加 `awaiting_approval` 终判（列出这些 workflow 与链接，MUST NOT 说 PASSED）；`checksVerdictSchema.status` 加 `"awaiting_approval"`、`checkBucketSchema` 加 `"action_required"`、两个 checks 条目的 schema 加 `suiteId` / `suite_id`；`src/gh/index.ts` 导出新类型。验证：`test/wait-pr-checks.test.ts` 渲染用例断言 status / 正文 / 链接；`pnpm exec vitest run test/gh-base.test.ts` 与结构化 schema 校验全绿

## 3. 工具接入与文档

- [x] 3.1 `read-github-pr-status` 的快照接入 suite 数据源（仍是立即返回），并更新它的 description 文案（列出 `action_required` 与 `suite_id`）。验证：`test/pr-status.test.ts` 新增用例——用 1.2 的 fixture 断言 6 个 `action_required` 条目出现且带 workflow run 名字/event/链接与各自 `suite_id`，`api.unused()` 为空，`structuredResult` 与文本同源
- [x] 3.2 更新 `wait-github-pr-checks` / `wait-github-commit-checks` 的 description 与 `promptSnippet`（说明遇到等待审批会立即返回 `awaiting_approval`），并同步 `README.md` 第 478 行附近的等待语义描述、`src/skills/github-ci-logs/SKILL.md` 里 `bucket` 取值与「等待审批没有 job 日志」的说明。验证：`pnpm check` 通过，人工核对 README / SKILL 的描述与 spec 一致

## 4. 集成回归

- [x] 4.1 跑 `pnpm test`、`pnpm check`、`pnpm lint`，确认无回归；对真实 PR #89（`valkey-io/libvalkey-py`）端到端跑一次等待链路（临时脚本直接调用 `waitChecksReport`，临时文件已删），确认返回 `awaiting_approval` 并列出 6 个 workflow 及其 run 链接

## Workflow follow-up

- 归档前同步三个主 spec（`gh-readonly` / `wait-github-pr-checks` / `wait-github-commit-checks`）的 `## Implementation` 段，说明新的 suite 数据源与分层位置。
- 归档该 change，并确认归档后的主 spec 与代码行为一致。
