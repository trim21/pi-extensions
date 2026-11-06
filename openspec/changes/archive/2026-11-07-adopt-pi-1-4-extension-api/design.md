# Design

## Context

`before_agent_start` 在 pi 1.2.0 起是 `BeforeAgentStartUserEvent | BeforeAgentStartCustomEvent`：base 只有 `systemPrompt` / `systemPromptOptions`，`prompt` 只存在于 user 变体（带 `messageType: "user"`），custom 变体带 `message`。我们 1.1.0 时代写的 `event.prompt` 因此在 1.2.0+ 无法通过类型检查。动机见 proposal.md。

现状约束：`package.json` 把三个 pi 包同时声明为 peer（`>=1.1.0`）与 dev（`>=1.1.0`），lockfile 锁在 1.1.0，所以仓库自身 CI 从来不测新版本；唯一能抬上去的通道是 lockfile maintenance PR。

## Goals / Non-Goals

**Goals:**

- 让 CI 从最低受支持版本开始测试 pi 扩展 API，而不是永远停在旧的锁定版本。
- 把「pi 升级」变成可评审的、必须人工合并的变更。

**Non-Goals:**

- 不追最新版（1.5.0）作为开发基线；也不改其它依赖的解析策略。

## Decisions

- **peer 用 `^1.4.0`、dev 用精确 `1.4.0`**：peer 表达兼容范围（1.x 内），dev 精确固定让 `pnpm install` 解析到范围的**最低**版本，等于把「最低受支持版本」变成 CI 的测试基线，避免「声明 1.4 兼容、实际只测 1.9」。
- **不引入 pnpm 的 `resolution-mode=lowest-direct`**：那是项目级开关，会把所有直接依赖都压到最低版本（undici、vitest 等），影响面远超需求。只为这三个包做「解析最低」，精确 pin 是等价且更局部的做法。
- **只对 `messageType === "user"` 命名**：custom 事件没有 prompt，命名没有输入；早退分支同时承担类型收窄，1.1.0 时代该事件也只会由 user prompt 触发，因此运行时行为不变。
- **renovate 只更新 devDependencies**：dev 的精确 pin 是 CI 的测试基线，必须跟着发版走；peer 范围是人手判断的兼容承诺，`matchDepTypes: ["peerDependencies"] + enabled: false` 让 renovate 不去改它。`separateMinorPatch` + group 让三个包同版本一起升级，但 minor 与 patch 分开成两个 PR，便于按风险分别评审。
- **用标签而不是分支名阻止自动合并**：Mergify 侧只加一条 `label!=ci:manual-merge`，renovate 侧用 `addLabels` 打标；标签语义比分支名正则更直白，也不会被 renovate 的分支重命名打破。

## Risks / Trade-offs

- [精确 pin 会让 renovate 的 PR 变成「pin 到 pin」的对比，diff 只改一个数字] → 这正是想要的效果：升级动作被显式化，且 `separateMinorPatch` 让 patch 与 minor 分开评审。
- [peer 范围被锁在 `^1.4.0` 后，若 pi 出 2.0 需要人手改] → 与现状一致（现在是 `>=1.1.0` 也需人手判断），且 `^` 明确表达只承诺 1.x。
- [dev 精确 1.4.0 时，1.5.0 里若修了 bug 我们看不到] → lockfile maintenance 不再会把 dev 抬走，但 renovate 的 group PR 会主动提出，评审即可。
