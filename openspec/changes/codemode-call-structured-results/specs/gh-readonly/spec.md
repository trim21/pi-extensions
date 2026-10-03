# Spec Delta

## ADDED Requirements

### Requirement: 结构化结果

首期以下工具在结果上 MUST 额外携带与其文本输出同源的机器可读结果 `structuredResult`：`read-github-issue`、`read-github-pr`、`read-github-issue-comments`、`read-github-pr-comments`、`read-github-pr-status`、`get-github-workflow-jobs`、`read-github-ci-logs`、`download-github-release-assets`、`wait-github-pr-checks`、`wait-github-commit-checks`。

`structuredResult` 是 Result：`{ ok: true; value }` 表示成功，`value` MUST 与该工具注册时声明的 `structuredSchema` 匹配；`{ ok: false; error }` 表示工具的结构化失败（`read-github-ci-logs` 的「job 不存在 / 仍在排队」与 `download-github-release-assets` 的「release 没有资产」MUST 走这一支），`error` MUST 是可直接展示的错误说明。`structuredResult` MUST NOT 改变工具面向模型的 `content` 文本、既有 `details` 字段或 `isError` 语义。

#### Scenario: 成功结果带结构化 value

- **WHEN** 调用上述任一工具并成功取得数据
- **THEN** `structuredResult` 为 `{ ok: true, value }`，`value` 与文本输出同源且与该工具声明的 `structuredSchema` 匹配

#### Scenario: 未找到类结果走 ok:false

- **WHEN** `read-github-ci-logs` 找不到 job 或 job 仍在排队，或 `download-github-release-assets` 的 release 没有资产
- **THEN** `structuredResult` 为 `{ ok: false, error }`，同时工具的 `content` 文本与 `isError` 与改动前一致

#### Scenario: 文本输出与 details 不变

- **WHEN** 调用上述任一工具
- **THEN** `content` 的文本与 `details` 与加 `structuredResult` 之前相同

#### Scenario: 未覆盖的工具不受影响

- **WHEN** 调用不在上述列表中的 gh 工具
- **THEN** 结果不带 `structuredResult`，codemode 侧对它的调用回退为文本
