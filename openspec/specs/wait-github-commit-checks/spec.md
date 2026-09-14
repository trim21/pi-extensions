# wait-github-commit-checks Specification

## Purpose

阻塞等待**任意 commit**（不要求是 PR head）的 CI 检查完成并给出终判，与 `wait-github-pr-checks` 共享同一套等待核心（轮询、合并判定、报告渲染），仅入口不同：commit 由参数直接给出（full/partial SHA、分支名或 tag 名，内部解析为 commit SHA），而非从 PR 解析。

等待语义与 `wait-github-pr-checks` 相同：**any(failed) 即返回失败；all(pass | skipped) 才返回成功；超时如实报告在途状态**。典型场景：等待某个 commit 的 push 事件触发的 runs。

## Requirements

### Requirement: commit 解析

`commit` 参数 MUST 支持非 PR 入口；解析失败 MUST 以带上下文的错误终止。

#### Scenario: SHA / 分支 / tag 解析

- **WHEN** `commit` 为 full SHA、partial SHA、分支名或 tag 名
- **THEN** 经 commit API 解析为该 commit 的 full SHA，后续轮询与报告都基于该 SHA；报告标题为 `commit <短SHA>`

### Requirement: 事件过滤

`event` 参数可选；设置时只判定该 workflow event 触发的 check runs。

#### Scenario: 严格匹配

- **WHEN** 指定 `event`（如 `push`）
- **THEN** 只保留 `event` 匹配的 check runs 参与 any(fail) / all(pass|skipped) 判定；commit status（触发事件未知）被排除

#### Scenario: 不过滤

- **WHEN** 未指定 `event`
- **THEN** 判定范围是该 commit 上的全部检查（status + check runs，含 push 与 pull_request 等各事件来源的条目）

### Requirement: 等待与返回语义

等待核心 MUST 复用 `wait-github-pr-checks` 的语义实现（超时行为、轮询容错、进度流式输出与失败详情补充，见 `openspec/specs/wait-github-pr-checks/spec.md`），检查项保持独立、同名不同来源分别显示。

#### Scenario: 共享语义不漂移

- **WHEN** commit 等待轮询到 any(fail) / all(pass|skipped) / 超时
- **THEN** 行为与 `wait-github-pr-checks` 一致，仅报告主题为 `commit <短SHA>` 而非 `PR #N`

## Implementation

- 与 `wait-github-pr-checks` 共享 `waitChecksReport` 核心（`src/gh-readonly.ts`）：`pollPrChecks`（含 `event` 过滤）→ `renderChecksVerdict`；`event` 过滤在每轮合并判定后应用（严格匹配）。
- commit 解析：`src/lib/github.ts` 的 `GithubChecksClient.headSha()`（octokit `repos.getCommit`，接受 SHA / 分支 / tag）。
- spec 中的共享语义在 `openspec/specs/wait-github-pr-checks/spec.md` 中描述，本文件只记录差异（commit 入口与事件过滤）。
