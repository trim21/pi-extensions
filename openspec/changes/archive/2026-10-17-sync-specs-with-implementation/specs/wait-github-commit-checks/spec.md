# Spec Delta

## MODIFIED Requirements

### Requirement: 等待与返回语义

等待核心 MUST 复用 `wait-github-pr-checks` 的语义实现（超时行为、轮询容错与失败详情补充，见 `openspec/specs/wait-github-pr-checks/spec.md`），检查项保持独立、同名不同来源分别保留。

#### Scenario: 共享语义不漂移

- **WHEN** commit 等待轮询到 any(fail) / all(pass|skipped) / 超时
- **THEN** 行为与 `wait-github-pr-checks` 一致：相同的载荷形状与判定结果，载荷不包含额外的调用上下文字段
