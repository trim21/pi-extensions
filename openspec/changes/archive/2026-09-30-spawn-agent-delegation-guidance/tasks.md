# Tasks

## 1. 工具描述与参数

- [x] 1.1 改写 `spawn-agent` 的工具描述：说明子 agent 看不到当前对话、只返回最终回答、同一条消息中的多个调用并发执行；在 `test/spawn-agent.test.ts` 增断言覆盖上述三点，`pnpm vitest run test/spawn-agent.test.ts` 通过
- [x] 1.2 改写 `task` 参数描述为「自包含任务」（写明仓库路径、确切问题、期望返回的文件路径 + 行号）；断言描述包含自包含与返回内容要求，测试通过
- [x] 1.3 补 `promptSnippet`，使 `spawn-agent` 出现在 "Available tools" 清单；断言注册的定义带有非空 `promptSnippet`，测试通过

## 2. 委托判据

- [x] 2.1 改写 `formatAgentListSection`：在可用子 agent 清单前加入判据段落（该委托 / 不该委托的情形、并发发起、结论只作定位线索），保留原有 `### Available subagents` 清单与 `agent` 参数提示；更新 `test/spawn-agent.test.ts` 的 `formatAgentListSection` 与 guideline 注入断言，`pnpm vitest run test/spawn-agent.test.ts` 通过
- [x] 2.2 核对修改后的 guideline 在 `src/system-prompt/index.ts` 的 `formatGuidelines` 渲染下仍为合法 Markdown 段落（多行、无 `- ` 前缀错位），用 `test/system-prompt.test.ts` 的既有渲染用例或新增用例验证

## 3. 收尾验证

- [x] 3.1 运行 `pnpm check` 与 `pnpm lint` 全绿
- [x] 3.2 运行 `pnpm test` 全绿，确认没有其它用例依赖旧的提示词文案
