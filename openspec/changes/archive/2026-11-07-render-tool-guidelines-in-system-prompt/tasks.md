# Tasks

## 1. 渲染工具级 guidelines

- [x] 1.1 `PromptInputs` 增加 `toolGuidelines?: Record<string, readonly string[]>`；`buildSystemPromptText` 从 `event.systemPromptOptions` 透传该字段。验证：`tsc --noEmit` 通过。
- [x] 1.2 `formatGuidelines` 改为 `(selectedTools, toolGuidelines, promptGuidelines)`：按 `selectedTools` 顺序收集条目，追加全局条目，trim + 去空 + 去重后排序渲染；无条目时返回空串。验证：新增用例覆盖「工具级条目出现」「未激活工具不出现」「跨来源去重」「空则省略块」。

## 2. 回归与验证

- [x] 2.1 更新 `test/system-prompt.test.ts` 现有 `formatGuidelines` 调用（单参数改三参数），保持原有断言语义。验证：`pnpm test test/system-prompt.test.ts` 全绿。
- [x] 2.2 新增端到端用例：用本仓库真实工具定义构造 `toolGuidelines`，断言 `buildSystemPromptText` 输出包含 spawn-agent 的 agent 清单段与 aft 的分工段。验证：该用例在改动前失败、改动后通过。
- [x] 2.3 运行 `pnpm check` 与 `pnpm lint`。验证：两者均无错误。

## 3. 文档

- [x] 3.1 更新 `src/system-prompt/index.ts` 顶部注释与 `PromptInputs` 字段说明，写明工具级指引来自 `toolGuidelines` 而非 `promptGuidelines`。验证：注释与实现一致，无残留的「只读 promptGuidelines」表述。

## Workflow follow-up

- 归档本 change 后，`openspec/specs/system-prompt/spec.md` 将成为该 capability 的当前行为文档。
