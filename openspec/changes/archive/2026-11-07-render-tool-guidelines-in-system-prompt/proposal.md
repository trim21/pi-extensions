# Proposal

## Why

本仓库每个工具定义的 `promptGuidelines` 从未进入 system prompt。`system-prompt` 扩展只读 `event.systemPromptOptions.promptGuidelines`，而 pi 在该字段里不承载工具级条目：工具级指引被收集进 `toolGuidelines: Record<name, string[]>`（pi `agent-session.ts:1789`），`promptGuidelines` 在基础装配里恒为 `[]`（`system-prompt.ts:70`）。结果 [src/system-prompt/index.ts:76-85](../../../src/system-prompt/index.ts:76) 的 `formatGuidelines` 永远拿到空数组。

影响面是整个仓库 25 处 `promptGuidelines` 声明：spawn-agent 的可用子 agent 清单、aft 工具集的分工说明、Bash/Read/Grep 的调用契约全部丢失，而 [openspec/specs/aft/spec.md](../../../openspec/specs/aft/spec.md) 的「guidelines 常驻注入」Scenario 已把这一行为当作既有承诺。

真实请求可以对照：explorer 子代理走 pi 默认渲染，`<rules>` 段 5,452 字符、每个工具的 guideline 都在；主会话走本仓库的 `prompt.md` 模板，`## Guidelines` 段为 0。

## What Changes

- `PromptInputs` 增加 `toolGuidelines?: Record<string, readonly string[]>`，由 `before_agent_start` 的 `event.systemPromptOptions.toolGuidelines` 填充。
- `formatGuidelines` 改为按 `selectedTools` 顺序收集各工具的 guidelines，再并入全局 `promptGuidelines`；条目 trim、去空、去重，空结果省略整个块。
- 不改变 `prompt.md` 的占位符约定、`formatTools` / `formatContextFiles` / `formatSkills` 的现有行为，也不改变子代理路径（子代理不加载本扩展，走 pi 默认渲染）。

## Capabilities

### New Capabilities

- `system-prompt`: 本仓库完全接管后的 system prompt 渲染，包括占位符装配、Available tools 清单、工具级与全局 guidelines 的合并、project context 与 skills 块。

### Modified Capabilities

无。

## Impact

- 代码：`src/system-prompt/index.ts`。
- 测试：`test/system-prompt.test.ts`（`formatGuidelines` 签名变化 + 工具级 guideline 的回归用例）。
- 行为：主会话 system prompt 增加约 2-3K 字符（25 条工具指引），模型重新获得工具作者写下的调用约束。
