# Spec Delta

## MODIFIED Requirements

### Requirement: commit 解析

`commit` 参数 MUST 支持非 PR 入口；解析失败 MUST 以带上下文的错误终止。

#### Scenario: SHA / 分支 / tag 解析

- **WHEN** `commit` 为 full SHA、partial SHA、分支名或 tag 名
- **THEN** 经 commit API 解析为该 commit 的 full SHA，后续轮询与载荷都基于该 SHA

### Requirement: 等待与返回语义

等待核心 MUST 复用 `wait-github-pr-checks` 的语义实现（超时行为、轮询容错与失败详情补充，见 `openspec/specs/wait-github-pr-checks/spec.md`），检查项保持独立、同名不同来源分别保留。

#### Scenario: 共享语义不漂移

- **WHEN** commit 等待轮询到 any(fail) / all(pass|skipped) / 超时
- **THEN** 行为与 `wait-github-pr-checks` 一致（相同的载荷形状与判定结果），仅调用上下文标识为 `commit <短SHA>` 而非 `PR #N`
