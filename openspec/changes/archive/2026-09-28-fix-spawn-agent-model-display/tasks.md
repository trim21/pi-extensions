# Tasks

## 1. footer 显示实际生效的模型

- [x] 1.1 `src/spawn-agent.ts`：`SubagentSession` 增加可选 `model`，`SubagentResult` 初始化不再用 frontmatter 的 `agent.model`，`runAgent` 在 session 创建后按 `session.model?.id` 设置 `result.model`（保留 `message_end` 里 `msg.model` 的兜底分支）；验证：模型名解析不到时 footer 显示 SDK fallback 后的模型
- [x] 1.2 `test/spawn-agent.test.ts`：`fakeSessionHarness` 支持注入 session 的 `model`，新增回归用例「frontmatter 声明的模型解析不到时，`result.model` 是实际生效的模型」；验证：该用例在改动前失败（显示 frontmatter 配置名）、改动后通过
- [x] 1.3 既有「collects messages and usage from message_end events」用例仍通过（fake session 不暴露 model 时由 `msg.model` 兜底）；验证：`pnpm exec vitest run test/spawn-agent.test.ts` 全绿

## 2. 规范与整体验证

- [x] 2.1 归档 change，确认 `openspec/specs/spawn-agent/spec.md` 的「进度可见」场景已含「末尾固定行显示实际生效模型」的表述；验证：`openspec archive` 无报错，主 spec 文本与 delta 一致
- [x] 2.2 跑 `pnpm check`、`pnpm lint`、`pnpm test` 全绿（收尾再统一跑一次 prettier）；验证：三条命令均无报错
