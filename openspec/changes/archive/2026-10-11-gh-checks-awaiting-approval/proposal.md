# Proposal

## Why

fork PR 首次贡献者的 workflow 在维护者批准前不会开始，GitHub 只在 **check suite** 层表达这个状态（`conclusion: action_required`、`latest_check_runs_count = 0`，对应一个 `conclusion: action_required` 的 workflow run），**不创建任何 check run**，也没有 commit status。

现有检查管道只读 combined statuses 与 check runs，因此这类 workflow 完全不可见，且会把「N 个 workflow 等待审批」判成 **PASSED**——实测 `valkey-io/libvalkey-py#89`：6 个 workflow 等待审批，`wait-github-pr-checks` 返回 `status: "success"`、`totalChecks: 1`（只有 DCO）。这与 `wait-github-pr-checks` spec 的「绝不把未完成的等待判成 PASSED」直接冲突，属于假绿。

## What Changes

- 检查快照新增第三个数据源 **check suite**：只把「已结束（`completed`）且没有 check run 的 suite」摊平成条目（有 check run 的 suite 仍由其 check run 代表；app 预建的未结束空壳 suite 一律忽略，否则会把等待拖到超时），条目的名字 / event / 链接 / run id 由 `check_suite_id` 匹配到的 workflow run 补齐（匹配不到时名字退化为该 suite 的 app）。
- 每个检查条目新增 **`suite_id`** 字段（check run 与摊平出来的 suite 条目带所属 suite 的 id，commit status 为 null），平坦列表不变，但 suite 层级可还原、可按 suite 分组。
- 新增 bucket **`action_required`**（等待人工审批，不会自行开始，与 `skipped` 区分）；check run 的 `action_required` conclusion 也从 `skipped` 改判到它。
- 等待语义：一旦出现 `action_required` 检查就**立即结束等待**（不受 `fail_fast` 影响，等审批不会自行开始，轮询无意义），返回新的 `status: "awaiting_approval"` 并列出这些 workflow 与链接；`fail` 仍然优先于它。
- `read-github-pr-status` 的快照同样列出这些条目（快照语义不变，仍是立即返回）。
- **BREAKING**（结构化 schema，codemode 消费者可见）：`checksVerdictSchema.status` 新增枚举值 `awaiting_approval`，`checkBucketSchema` 新增枚举值 `action_required`。此前被判成 `skipped` / `success` 的「等待审批」workflow，现在返回 `awaiting_approval`。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `wait-github-pr-checks`：检查合并与判定映射新增 check suite 数据源与 `action_required` bucket；等待与返回语义新增「立即返回 awaiting_approval」。
- `wait-github-commit-checks`：事件过滤（`event` 参数）下 suite 条目的归属规则。
- `gh-readonly`：`read-github-pr-status` 状态快照的 checks 来源与 `bucket` 枚举。

## Impact

- 代码：`src/lib/github.ts`（`GithubChecksClient` 新增 `suites` / `workflowRuns` 读取，check run 的 event 映射改为复用后者）、`src/gh/base.ts`（`CheckBucket`、`mergeChecks`、`pollPrChecks`、`renderChecksVerdict`）、`src/gh/schemas.ts`（两个枚举）、`src/gh/index.ts`（导出）。
- 测试：`test/wait-pr-checks.test.ts`（bucket 映射、等待循环、终判渲染）、`test/pr-status.test.ts` + `test/fixtures/github/`（用 `valkey-io/libvalkey-py#89` 的录制响应做「无 check run 的 suite」回归）。
- 不在本次范围内：分支保护 / ruleset 的 required status checks（merge box 里 `Expected — Waiting for status to be reported` 那一批），既不进检查快照也不进判定；它属于「合并就绪度」而不是「commit 上的 CI 状态」，且 `wait-github-commit-checks` 没有 base 分支概念。
- 请求成本：每轮轮询多 1 个请求（`checks.listSuitesForRef`），workflow run 列表本来就要取（用于 event 标注），改为显式共用。
- 兼容性：`checksVerdictSchema` / `checkBucketSchema` 是新增枚举值（非重命名），旧值语义不变；但依赖「所有 workflow 都能跑到终态」的调用方会看到新的终判值。
