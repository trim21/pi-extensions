# wait-github-checks Specification

## Purpose

阻塞等待某个 commit（PR head 或任意 commit）的 CI 检查完成并给出终判。判定数据来自该 commit 的 combined-status 与 check-runs API（octokit 直连，不经由 `gh pr checks` 与其退出码），同时覆盖经典 commit status（Azure DevOps、Jenkins 等外部 CI）与 check runs（GitHub Actions、GitHub App）。两个入口共享同一套轮询、合并、判定与汇总核心，只用参数区分：**PR 入口**从 PR 解析 head commit，**commit 入口**直接给出 commit（full/partial SHA、分支名或 tag 名）并可只判定某个 workflow event 触发的检查。

等待语义：**any(failed) 即返回失败；all(pass | skipped) 才返回成功；超时如实返回在途状态，绝不把未完成的等待判成 PASSED**。

## Requirements

### Requirement: commit 解析

`commit` 参数 MUST 支持非 PR 入口；解析失败 MUST 以带上下文的错误终止。

#### Scenario: SHA / 分支 / tag 解析

- **WHEN** `commit` 为 full SHA、partial SHA、分支名或 tag 名
- **THEN** 经 commit API 解析为该 commit 的 full SHA，后续轮询与载荷都基于该 SHA

### Requirement: 检查合并与判定映射

三类来源各自判成独立条目后拼成统一的检查快照，**不按名称合并**（同名条目分别保留），再映射为 `pass / skipped / fail / pending / action_required`：

- commit status：`success` → pass；`failure` / `error` → fail；`pending` / `expected` 及未知值 → pending
- check run：未 `completed`（conclusion 为空）→ pending；`success` → pass；`skipped` / `neutral` / `stale` → skipped；`failure` / `timed_out` / `cancelled` / `startup_failure` → fail；`action_required` → action_required；未知 conclusion → pending
- check suite：MUST 只纳入**已结束（`status: completed` 且 conclusion 非空）且没有任何 check run** 的 suite（未结束的 suite 是 app 在每个 commit 上预建的空壳，如 netlify / vercel / renovate，MUST NOT 单独立条；有 check run 的 suite 已由其 check run 代表，MUST NOT 重复计入）；`action_required` → action_required；`success` → pass；`skipped` / `neutral` / `stale` → skipped；`failure` / `timed_out` / `cancelled` / `startup_failure` → fail；未知 conclusion → pending

`action_required` 表示「等待人工审批，不会自行开始」（fork PR 首次贡献者的 workflow 在批准前不创建 check run，只留下一个 `action_required` 的 suite 与 workflow run），与 `skipped`（终态、不会运行）区分。每个条目 MUST 带 `suiteId`（check run 与其所属 suite 摊平出来的条目为该 suite 的 id，commit status 为 null），使平坦列表可按 suite 分组。suite 条目的名字、触发事件、链接与 run id MUST 取自 `check_suite_id` 匹配到的 workflow run；匹配不到时事件留空、名字 MUST 退化为该 suite 的 app（MUST NOT 静默丢弃该条目）。

#### Scenario: 同名不同来源分别保留

- **WHEN** 同名条目在同一 commit 上出现多条（CI 系统对同一检查双报 status + check run，或同一 workflow 同时被 push 与 pull_request 事件触发——两类事件的 check runs 都挂在 PR head commit 上）
- **THEN** 各条目分别保留为独立检查、各自判定，不做聚合；等待语义（any fail / all pass|skipped）作用于全部条目，因此任何一条失败都不会被同名成功掩盖

#### Scenario: 未知值不误判

- **WHEN** 出现映射表之外的 state / conclusion
- **THEN** 归为 pending，等待不能被未知值提前终止

#### Scenario: 来源事件是独立字段

- **WHEN** 检查条目带触发事件信息
- **THEN** 载荷里 `name` MUST 保持 GitHub 给出的原名，触发事件是独立字段 `event`，两者 MUST NOT 在数据里拼成一个字符串（需要展示成 `build (pull_request)` 这类形式时由调用方自己组合）；事件未知（外部 CI status、匹配不到 workflow run 的 suite 等）时 `event` 为空

#### Scenario: 无 check run 的 suite 单独成条

- **WHEN** 某 commit 上存在已结束、且没有 check run 的 suite（等待维护者审批的 workflow）
- **THEN** 它作为独立检查出现在快照里，`bucket` 为 `action_required`，`suiteId` 为该 suite 的 id，名字 / event / 链接 / run id 取自匹配到的 workflow run

#### Scenario: 未结束的空壳 suite 不产生条目

- **WHEN** 某 suite 仍未结束（`status` 不是 `completed`、conclusion 为空）且没有 check run（GitHub 为每个 app 在每个 commit 上预建的 suite，多数 app 从不往里写东西）
- **THEN** 它不产生检查条目，快照与判定都不受它影响（否则这些永远不结束的空壳会把等待拖到超时）

#### Scenario: 有 check run 的 suite 不重复计数

- **WHEN** 某 suite 有它自己的 check runs
- **THEN** 该 suite 本身不产生额外条目，快照里只有它的 check runs（各自带该 suite 的 `suiteId`），检查总数与引入 suite 数据源之前一致

### Requirement: 事件过滤

`event` 参数（commit 入口）可选；设置时 MUST 只判定该 workflow event 触发的检查条目。

#### Scenario: 严格匹配

- **WHEN** 指定 `event`（如 `push`）
- **THEN** 只保留 `event` 匹配的 check runs 与 suite 条目参与 any(fail) / any(action_required) / all(pass|skipped) 判定；commit status 与事件未知的 suite（匹配不到 workflow run）被排除

#### Scenario: 不过滤

- **WHEN** 未指定 `event`
- **THEN** 判定范围是该 commit 上的全部检查（status + check runs + 无 check run 的 suite，含 push 与 pull_request 等各事件来源的条目）

#### Scenario: 等待审批的 workflow 参与判定

- **WHEN** 某 workflow 因等待维护者审批而没有 check run，且它的 workflow run 事件与指定的 `event` 相同
- **THEN** 该 suite 条目参与判定，并按等待语义立即返回 `awaiting_approval`

### Requirement: 等待与返回语义

轮询间隔 30s、截止 600s。返回时机 MUST 只由检查快照决定：`any(fail)`、`any(action_required)` 或 `all(pass | skipped)`。

#### Scenario: 全部通过

- **WHEN** 某一轮所有检查均为 pass 或 skipped，且没有任何 action_required
- **THEN** 返回 PASSED，结构化载荷 `status: "success"` 并携带 checks 快照

#### Scenario: 任一失败

- **WHEN** 某一轮出现 fail 检查
- **THEN** `fail_fast: true` 时立即返回 FAILED；默认（false）继续等待其余检查完成或超时后返回 FAILED，载荷里列出失败检查与链接

#### Scenario: 等待人工审批

- **WHEN** 某一轮出现 action_required 检查（等待维护者审批的 workflow）
- **THEN** 不再轮询后续轮次（该状态不会自行变化），立即返回 `status: "awaiting_approval"`、`totalChecks` 与该轮全部检查的快照（含这些 workflow 的名字与链接），MUST NOT 判 PASSED，也不受 `fail_fast` 影响

#### Scenario: 失败优先于等待审批

- **WHEN** 同一轮里既有 fail 也有 action_required 检查
- **THEN** 返回 FAILED（载荷列出失败检查），等待审批的 workflow 只在快照里保留

#### Scenario: 超时

- **WHEN** 截止时仍有检查 pending，且快照里没有 fail 或 action_required 检查
- **THEN** 返回 `status: "pending"` 的在途快照（载荷列出未完成检查），不判 PASSED / FAILED，也不抛错；快照里已有 fail 时按「任一失败」返回 FAILED

#### Scenario: 轮询容错

- **WHEN** 单轮 API 请求失败
- **THEN** 记录错误并继续轮询至截止；仅当截止前从未成功取得任何一轮数据时抛出带上下文的错误

#### Scenario: 进度流式输出

- **WHEN** 每轮轮询完成且仍有检查在途
- **THEN** 不输出进度：工具只经 codemode 调用，没有会消费 `onUpdate` 的调用方；判定与快照不受影响

#### Scenario: 轮询到终止状态

- **WHEN** 任一入口轮询到 any(fail) / all(pass|skipped) / 超时
- **THEN** 两个入口的载荷形状与判定结果一致，载荷不包含额外的调用上下文字段

### Requirement: 失败详情仅为展示补充

Actions jobs 详情只服务于 FAILED 载荷里的失败 job 明细（`failedJobs`）；判定 MUST 只来自检查快照，补充数据的有无不改变结论。

#### Scenario: Actions jobs 补充

- **WHEN** 判定为 FAILED
- **THEN** 额外抓取该 head commit 的 Actions workflow jobs，未成功的 job 作为 `failedJobs` 进入载荷

#### Scenario: 补充抓取失败不影响结论

- **WHEN** Actions jobs 抓取失败
- **THEN** 载荷的 `failedJobs` 为空，FAILED 结论不变

## Implementation

- 分层（均在 `src/gh/base.ts`，后两层为纯函数、可独立单测）：`mergeChecks` 合并与 bucket 映射（commit statuses + check runs + 已结束且没有 check run 的 suites，后者的元数据由 `checkSuiteId` 匹配 workflow run 补齐）→ `pollPrChecks` 等待循环（返回 `completed / fail_fast / awaiting_approval / timeout` 与最终快照、`elapsedMs`）→ `checksVerdict` 判定汇总（`status` + `failedJobs`）；两个工具入口 `src/gh/tools/wait-pr-checks.ts` 与 `src/gh/tools/wait-commit-checks.ts` 共享 `waitChecksReport` 编排核心，`event` 过滤在每轮合并判定后应用（严格匹配），因此无 check run 的 suite 条目按其 workflow run 的 event 一起参与或一起被排除。
- commit 解析：`src/lib/github.ts` 的 `createGithubChecks(api).headSha()`（octokit `repos.getCommit`，接受 SHA / 分支 / tag）；PR 入口用 `pullHead()` 取 head commit。
- API 客户端：`src/lib/github.ts` 的 `createGithubChecks(api)`（octokit；`api` 是与 search / reads 共用的 `createGithubApi` accessor，token 只取一次并闭包缓存，401 时丢弃缓存重试一次），提供 `statuses` / `checkRuns`（带 `checkSuiteId`）/ `suites` / `workflowRuns` / `actionJobs`。`statuses` 用单次 `repos.getCombinedStatusForRef({ per_page: 100 })`，其余四个用 `octokit.paginate`（per_page=100）。check run 的 event 与 suite 的名字/event/链接都来自同一次 `workflowRuns`（`run.check_suite_id` 是 suite 的 join key）。
- signal 由调用方构造并持有，轮询层只观察不取消；工具侧 `signal ?? new AbortController().signal`。
- 单轮失败不终止轮询；截止时若从未成功取得任何一轮则抛出最后的错误。
- 测试：`test/wait-pr-checks.test.ts`，不 mock API 客户端层，直接单测合并映射、等待循环与判定汇总；真实 PR 快照由 `test/pr-status.test.ts` 的 cassette（`test/fixtures/github/awaiting-approval-*.json`，录自 `valkey-io/libvalkey-py#89`）覆盖。
