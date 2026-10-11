# Spec Delta

## MODIFIED Requirements

### Requirement: 事件过滤

`event` 参数可选；设置时 MUST 只判定该 workflow event 触发的检查条目。

#### Scenario: 严格匹配

- **WHEN** 指定 `event`（如 `push`）
- **THEN** 只保留 `event` 匹配的 check runs 与 suite 条目参与 any(fail) / any(action_required) / all(pass|skipped) 判定；commit status 与事件未知的 suite（匹配不到 workflow run）被排除

#### Scenario: 不过滤

- **WHEN** 未指定 `event`
- **THEN** 判定范围是该 commit 上的全部检查（status + check runs + 无 check run 的 suite，含 push 与 pull_request 等各事件来源的条目）

#### Scenario: 等待审批的 workflow 参与判定

- **WHEN** 某 workflow 因等待维护者审批而没有 check run，且它的 workflow run 事件与指定的 `event` 相同
- **THEN** 该 suite 条目参与判定，并按共享等待语义立即返回 `awaiting_approval`
