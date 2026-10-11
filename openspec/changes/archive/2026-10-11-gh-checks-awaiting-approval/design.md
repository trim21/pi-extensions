# Design

## Context

检查管道现分三层：`src/lib/github.ts` 的 `createGithubChecks`（octokit HTTP）→ `src/gh/base.ts` 的 `mergeChecks` 与 `pollPrChecks`（纯判定/轮询）→ `renderChecksVerdict`（报告）。数据源只有 combined statuses 与 check runs。

GitHub 侧的三层模型（实测 `valkey-io/libvalkey-py#89` head `6d8644d9`）：check suite 是「某个 app 在某次触发下、针对某个 commit」的容器，check run 是它内部的条目（Actions 里一个 workflow run 一个 suite、一个 job 一个 check run）。等待维护者审批的 workflow **只创建 suite 与 workflow run，不创建任何 check run**，其 `conclusion` 为 `action_required`。因此只看 check runs 的管道天然看不到它。

约束：`event` 标注现在依赖 check run 的 `details_url` → workflow run id → `actions.listWorkflowRunsForRepo?head_sha=` 的匹配，这段逻辑藏在 `checkRuns()` 内部；suite 没有 `details_url`，只有 `check_suite_id`。

## Goals / Non-Goals

**Goals:**

- 让「等待人工审批的 workflow」进入检查快照与终判，且判定语义诚实（不判 PASSED）。
- 保持三层分层与纯函数可单测：HTTP 层只取数，判定层是纯函数。
- 每轮请求数只增加必要的一个。

**Non-Goals:**

- 不做「替用户批准 workflow」这类写操作（本仓库的 gh 工具是只读的）。
- 不改 `read-github-pr-status` 的「立即返回快照」语义。
- 不为 suite 层新增独立工具（如 `read-github-check-suites`）。
- 不处理 run 级 API 的其它等待态（environment 保护规则等），除非它们同样表现为无 check run 的 suite。
- **不读分支保护 / ruleset 的 required status checks**（merge box 里 `Expected — Waiting for status to be reported` 那批）。它回答的是「这个 PR 能不能合并」而不是「这个 commit 上的 CI 现在什么状态」：来源是 `rules/branches/<base>`（按 base 分支而非 commit），名字是 job 名而非 workflow 名，且 `wait-github-commit-checks` 没有 base 分支概念。留作独立 change。

## Decisions

**1. 第三数据源取 check suite（`checks.listSuitesForRef`），而不是 workflow run 列表。**
workflow run 列表（`listWorkflowRunsForRepo?head_sha=`）确实能看到 `action_required`，但它不带 suite→check run 的对应关系，无法判断某个 run 是否已经由 check runs 代表（同一 workflow 被 push 与 pull_request 各触发一次时会导致重复计数），也看不到非 Actions app 的 suite。以 suite 为权威来源、run 列表只用于补齐元数据，职责最清晰。

**2. 只展开「已结束（`completed`）且没有 check run」的 suite。**
判定用的是实际取到的 check runs 的 `check_suite_id` 集合，而不是 suite 的 `latest_check_runs_count`：后者是冗余计数，与实际列表不一致时会多报或少报条目。「已结束」这个条件是实现中发现必须加的：GitHub 会为**每个 app 在每个 commit 上预建一个 suite**，多数 app（netlify / vercel / azure-pipelines / renovate / buildjet / codspeed…）从不往里写东西，这些 suite 永远停在 `queued`/conclusion 为空——实测 `trim21/pi-extensions#137` 的 head 上 15 个 suite 里有 11 个是这种空壳。把它们当 pending 检查会让每一次 `wait` 必然拖到 600s 超时（而且是永远超时），因此只有「已结束」这一支才可能表示「真的发生了什么但没产生 check run」（等待审批就是这种）。有 check run 的 suite 完全由其 check runs 代表，检查总数因此与改动前一致。替代方案「所有 suite 都摊平」还会让父与子同时进入列表：`valkey-io/libvalkey-py#87` 的 head 会从 29 条变成 37 条（`CI` 那一行和它 22 个 job 同时出现），`totalChecks` 与判定跟着重复计数，故否决。

**3. 全部摊平进同一个 `checks` 数组，另加 `suite_id` 字段；不给 suite 单开一层或一个工具。**
调用方要的是一份「这个 commit 上现在有哪些 check、各自什么状态」的平坦列表，suite 只是归属信息。因此不引入新的条目类型或新的顶层字段，只给每个条目加 `suite_id`（check run 取 `check_run.check_suite.id`，摊平出来的 suite 条目取自身 id，commit status 为 null），既可以按 suite 分组，也能还原树形关系。替代方案（保留层级、checks 里嵌 suites）会让所有既有消费者改结构，收益只有"层次好看"。

**4. suite 条目的元数据取自 `check_suite_id` 匹配到的 workflow run，匹配不到时退化为 `app.slug`。**
`CheckSuite` 没有 name/event 字段；名字只存在于 workflow run（`run.name`，如 `CI` / `FreeBSD` / `Enforce semi-linear git history`，链接即 `html_url`）。反向查不到（suite 对象不带 run id），所以实现上是「列 run → 按 `check_suite_id` 建索引」。run 列表本来就要取（check run 的 event 标注靠它），因此不额外加请求。非 Actions app 的孤儿 suite 匹配不到 run，此时用 app slug 当名字并留空事件，而不是丢弃条目——宁可名字难看，也不要重新制造不可见状态。

**5. `action_required` 是独立 bucket，`awaiting_approval` 是独立 verdict status。**
bucket 描述单个检查，status 描述整轮终判。复用 `skipped` 正是假绿的来源（原注释理由「不会运行所以等同 skipped」只考虑了「等待无意义」，忽略了「结论必须是未完成」）；复用 `pending` 则表达不出「不会自行变化」。两者都新增，代价是结构化 schema 多一个枚举值（proposal 已标 BREAKING）。

**6. 出现 `action_required` 立即结束等待，且失败优先。**
该状态只有人（维护者批准）或新 commit 才能改变，轮询 600s 注定徒劳；立即返回让调用方能马上把「需要人工审批」转达用户。同一轮里 `fail` 仍然优先于 `action_required`——失败是可行动的，等待审批是解释性的。替代方案（当作 pending 轮询到超时后返回 pending）会浪费整个截止时间，已被否决。

**7. check run 的 `action_required` conclusion 也改判到新 bucket。**
同一语义（等待人工操作）不该按来源给两种结论。这会改变第三方 app / environment 审批场景的既有结论：从 `success` 变为 `awaiting_approval`，语义更正确。

**8. event 补齐从 `checkRuns()` 内部移到合并层，workflow run 列表成为显式数据源。**
`CheckRun` 去掉 `event` 字段（它本来就是派生值），由 `mergeChecks(statuses, checkRuns, suites, workflowRuns)` 统一按 `runId` / `checkSuiteId` 匹配。这样 suite 与 check run 共用同一次 run 列表请求，每轮请求从「2 + 条件 1」变成「3 + 条件 1」，而不是 4 个。

## Risks / Trade-offs

- [每轮多一个 `listSuitesForRef` 请求] → 与其它源同等待遇：单轮失败按现有容错逻辑记错并继续轮询，只有「截止前从未成功过一轮」才抛错。
- [把 app 预建的空壳 suite 当成 pending 会让 wait 永远拖到超时] → 只展开 `completed` 的孤儿 suite（决策 2）；单测覆盖「queued/in_progress 的孤儿 suite 被忽略」，端到端由 PR #137 的 fixture（11 个 queued 空壳 + 完整快照条数不变）锁住。
- [既有消费者的结论发生变化（skipped→action_required、success→awaiting_approval）] → 这是本 change 的目的；proposal 已标注 BREAKING，schema 是新增枚举值而非重命名，旧值语义未变。
- [匹配依赖 `check_suite_id`，GitHub 若在某些事件上不填该字段会导致退化命名] → 退化为 app slug 仍然可见；不因为元数据缺失而丢条目。
- [录制 fixture 的线上 PR 会变化] → fixture 是冻结快照，测试不依赖线上状态；只有重新录制时才需要线上仍存在该 PR。

## Migration Plan

纯代码改动，无数据迁移：改 `src/lib/github.ts`、`src/gh/base.ts`、`src/gh/schemas.ts`、`src/gh/index.ts` 后跑 `pnpm test` / `pnpm check` / `pnpm lint`；回滚即 revert 该提交。归档时除 requirements 合并外，还要同步更新三个主 spec 的 `## Implementation` 段（描述数据源与分层的位置）。
