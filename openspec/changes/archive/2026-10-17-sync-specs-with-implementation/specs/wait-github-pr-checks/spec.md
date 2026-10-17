# Spec Delta

## MODIFIED Requirements

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
