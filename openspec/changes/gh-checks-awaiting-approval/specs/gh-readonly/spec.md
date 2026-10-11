# Spec Delta

## MODIFIED Requirements

### Requirement: 状态快照与 run 级等待

`read-github-pr-status` 的 checks 状态快照（commit statuses + check runs + 无 check run 的 check suites）继续走 octokit 并立即返回；`wait-github-pr-checks` / `wait-github-commit-checks` 的轮询与判定见独立 spec（`openspec/specs/wait-github-pr-checks/`）。`watch-github-run` 改为按固定间隔轮询 `actions.getWorkflowRun`（间隔与上限沿用等待工具的 30s / 600s），轮询期间 MUST 通过 `onUpdate` 报告当前状态；超过上限时 MUST 以超时结束而不是挂住。

#### Scenario: 状态快照

- **WHEN** 调用 `read-github-pr-status`（`number` 必填、`repo` 可选）
- **THEN** 走 octokit 读该 PR head commit 的 commit statuses、check runs 与 check suites，立即返回 JSON `{pr, repo, head_sha, checks:[{name, bucket, event, run_id, job_id, url, suite_id}]}`，不等待；`bucket` 为 pass / fail / pending / skipped / action_required，Actions 来源的 check 带 `run_id` / `job_id`（check run 由 `details_url` 解析，suite 条目取自 `check_suite_id` 匹配到的 workflow run），非 Actions 的 check 两者为 null；`suite_id` 为该检查所属 suite（commit status 为 null）

#### Scenario: 等待审批的 workflow 也在快照里

- **WHEN** 该 head commit 上有等待维护者审批的 workflow（只有 check suite 与 workflow run，没有 check run）
- **THEN** 快照里出现对应条目（名字、event 与链接取自其 workflow run），`bucket` 为 `action_required`、`suite_id` 为其 suite id，不再被静默省略

#### Scenario: run 级等待

- **WHEN** `watch-github-run` 等待中
- **THEN** 每次轮询报告当前 `status` / `conclusion`，结束后给出最终状态与载荷；超过上限以超时错误结束，不挂住调用方
