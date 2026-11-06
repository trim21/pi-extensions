# Design

## Context

见 proposal.md — Why。渲染侧的约束来自 pi 的事件形状：`before_agent_start` 的 `systemPromptOptions` 同时带 `toolGuidelines: Record<string, string[]>`（按工具聚合，`agent-session.ts:3668` 从已注册工具重建）与 `promptGuidelines: string[]`（全局，本仓库装配下恒空）。`selectedTools` 是本次请求实际激活的工具名。

当前 `formatGuidelines(promptGuidelines)` 只接受一个 `string[]`，并按 `localeCompare` 排序后渲染。

## Goals / Non-Goals

**Goals:**

- 让工具作者写在工具定义上的 `promptGuidelines` 真正到达模型。
- 保持 `prompt.md` 的占位符契约与其余块的行为不变。
- 渲染结果对同一组工具是确定的，不受注册顺序影响。

**Non-Goals:**

- 不改变子代理路径（子代理不加载本扩展，继续走 pi 默认渲染）。
- 不调整 `prompt.md` 的静态文本、skills 或 project context 的体积。
- 不为 codemode 描述、工具描述等其它上下文成本做优化。

## Decisions

**1. 在 `PromptInputs` 上增加 `toolGuidelines`，而不是让 `system-prompt` 去拿工具总线。**

`system-prompt` 是独立扩展入口，与 `src/index.ts` 分属不同模块图，拿不到那条总线实例。pi 已经把每个注册工具的 guidelines 聚合进事件，扩展现有的 duck-typed `PromptInputs`（已有 `toolSnippets` 同源）是最小改动。备选「让入口把总线暴露给 system-prompt」需要跨入口共享状态，与「每个入口独立模块图」的既有约束冲突。

**2. 合并顺序：先按 `selectedTools` 收集工具级条目，再追加全局条目，最后排序。**

收集时按 `selectedTools` 顺序遍历，保证只取激活工具；排序沿用现有的 `localeCompare`，让渲染结果与注册顺序、配置顺序无关（现有测试也断言了排序）。备选「完全对齐 pi `buildRules` 的原始顺序」会改变现有输出与测试，收益只是与默认渲染更像，不值得。

**3. 去重放在收集之后、排序之前，按 trim 后的内容比较。**

pi 的 `_normalizePromptGuidelines` 已经在工具维度内去重，跨工具与全局之间仍可能重复（例如 codemode 的两条 guideline 与全局条目）。统一在一次 Set 里去重，语义是「同一段文字只出现一次」。

**4. `formatGuidelines` 直接改签名，不保留旧重载。**

仓库现有规范是不加向后兼容 shim；调用点只有 `buildSystemPromptText` 与测试，改签名可控。

## Risks / Trade-offs

- [system prompt 变长约 2-3K 字符] → 这是设计本来的意图；真正需要控制体积时应该从 skills 与 codemode 描述入手，而不是砍掉工具契约。
- [排序会打散「按工具分组」的语义] → 现有输出格式已经是「## Guidelines + 空行分隔的独立段落」，本来就没有分组标题；逐段内容自带标题（如 `### Delegating to subagents`），排序不影响可读性。
- [工具在 `session_start` 里注册，事件里的 `toolGuidelines` 依赖 pi 的刷新时序] → pi 在每次 `registerTool` 后 `refreshTools()` 并重建 `_baseSystemPromptOptions`（`loader.ts:309`、`agent-session.ts:3668`），`before_agent_start` 晚于注册，实测子代理请求的 `<rules>` 段即由该路径产出。

## Migration Plan

无数据迁移。改动随下一次 pi 重启（或 `/reload`）生效；回滚只需还原 `src/system-prompt/index.ts` 与测试。
