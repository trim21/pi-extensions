# wait-github-pr-checks Specification

## Purpose

阻塞等待 PR 全部 CI 检查完成并给出终判。判定数据来自 PR head commit 的 combined-status 与 check-runs API（octokit 直连，不经由 `gh pr checks` 与其退出码），同时覆盖经典 commit status（Azure DevOps、Jenkins 等外部 CI）与 check runs（GitHub Actions、GitHub App）。

等待语义：**any(failed) 即返回失败；all(pass | skipped) 才返回成功；超时如实报告在途状态，绝不把未完成的等待判成 PASSED**。

## Requirements

### Requirement: 检查合并与判定映射

两类检查按名称合并成统一的检查快照，同名时 check run 优先，再映射为 `pass / skipped / fail / pending`：

- commit status：`success` → pass；`failure` / `error` → fail；`pending` / `expected` 及未知值 → pending
- check run：未 `completed`（conclusion 为空）→ pending；`success` → pass；`skipped` / `neutral` / `stale` → skipped；`failure` / `timed_out` / `cancelled` / `startup_failure` → fail；`action_required`（等待维护者批准，永远不会运行）→ skipped；未知 conclusion → pending

#### Scenario: 同名不同来源分别保留

- **WHEN** 同名条目在同一 commit 上出现多条（CI 系统对同一检查双报 status + check run，或同一 workflow 同时被 push 与 pull_request 事件触发——两类事件的 check runs 都挂在 PR head commit 上）
- **THEN** 各条目分别保留为独立检查、各自判定，不做聚合；等待语义（any fail / all pass|skipped）作用于全部条目，因此任何一条失败都不会被同名成功掩盖

#### Scenario: 未知值不误判

- **WHEN** 出现映射表之外的 state / conclusion
- **THEN** 归为 pending，等待不能被未知值提前终止

#### Scenario: 来源事件标注

- **WHEN** 渲染检查列表与 FAILED 报告中的检查名
- **THEN** 有触发事件信息的检查按 GitHub UI 风格在名字后标注（如 `build (pull_request)`）；事件未知（外部 CI status 等）时不标注

### Requirement: 等待与返回语义

轮询间隔 30s、截止 600s。返回时机只由检查快照决定：any(fail) 或 all(pass | skipped)。

#### Scenario: 全部通过

- **WHEN** 某一轮所有检查均为 pass 或 skipped
- **THEN** 返回 PASSED，details `status: "success"` 并携带 checks 快照

#### Scenario: 任一失败

- **WHEN** 某一轮出现 fail 检查
- **THEN** `fail_fast: true` 时立即返回 FAILED；默认（false）继续等待其余检查完成或超时后返回 FAILED，列出失败检查与链接

#### Scenario: 超时

- **WHEN** 截止时仍有检查 pending
- **THEN** 返回 `status: "pending"` 的在途快照（列出未完成检查），不判 PASSED / FAILED，也不抛错

#### Scenario: 轮询容错

- **WHEN** 单轮 API 请求失败
- **THEN** 记录错误并继续轮询至截止；仅当截止前从未成功取得任何一轮数据时抛出带上下文的错误

#### Scenario: 进度流式输出

- **WHEN** 每轮轮询完成且仍有检查在途
- **THEN** 经 onUpdate 流式输出纯文本进度行（非标题）与仍在途的检查列表（运行中在前、排队在后，隐藏已完成项）

### Requirement: 失败详情仅为展示补充

Actions jobs 详情只服务于 FAILED 报告的可读性；判定 MUST 只来自检查快照，补充数据的有无不改变结论。

#### Scenario: Actions jobs 补充

- **WHEN** 判定为 FAILED
- **THEN** 额外抓取该 head commit 的 Actions workflow jobs，未成功的 job 以子列表展示

#### Scenario: 补充抓取失败不影响结论

- **WHEN** Actions jobs 抓取失败
- **THEN** 降级为输出提示，FAILED 结论不变

## Implementation

- 分层（均在 `src/gh-readonly.ts`，后两层为纯函数、可独立单测）：`mergeChecks` 合并与 bucket 映射 → `pollPrChecks` 等待循环（返回 `completed / fail_fast / timeout` 与最终快照、`elapsedMs`）→ `renderChecksVerdict` 终判与报告渲染。
- API 客户端：`src/lib/github.ts` 的 `createGithubChecks()`（octokit，token 每次 `gh auth token` 获取并闭包缓存，401 时丢弃缓存重试一次），提供 `statuses` / `checkRuns`（`octokit.paginate` 分页，per_page=100）/ `actionJobs`。
- signal 由调用方构造并持有，轮询层只观察不取消；工具侧 `signal ?? new AbortController().signal`。
- 单轮失败不终止轮询；截止时若从未成功取得任何一轮则抛出最后的错误。
- 测试：`test/wait-pr-checks.test.ts`，不 mock API 客户端层，直接单测合并映射、等待循环与终判渲染。
