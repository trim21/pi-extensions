# Proposal

## Why

子 agent 的 frontmatter 写了不存在（或拼错）的模型名时，`resolveModel` 拿到 `undefined`（`ModelRuntime.getModel` 对未注册模型返回 `undefined`，不抛错），`createAgentSession` 静默 fallback 到 pi 的默认模型——子代理照常运行，但进度面板 footer 显示的仍是 frontmatter 里那个从未运行的模型名：`SubagentResult.model` 初始化为 `agent.model`，而 `message_end` 里「用真实模型覆盖」的分支是 `if (!result.model)`，初始值非空使它永远不生效。用户看不到发生了 fallback，以为自己写的模型生效了。

## What Changes

- footer（末尾固定行的模型名）改为显示本次运行**实际生效**的模型：session 创建后取 SDK 解析结果（`AgentSession.model` 即 `agent.state.model`，已包含 fallback 后的模型），不再回显 frontmatter 配置原文。
- 没有任何 assistant 消息时不丢失模型信息：保留 `message_end` 里由 `msg.model` 兜底填充的路径。
- `SubagentSession` 接口暴露可选的 `model`（真实 `AgentSession.model` 结构兼容），测试注入的 fake session 可显式提供。
- `test/spawn-agent.test.ts` 补回归测试：frontmatter 的模型解析不到时，`result.model` 是 fake session 暴露的实际模型，而不是 frontmatter 里写的名字。
- `openspec/specs/spawn-agent/spec.md` 的「进度可见」场景明确末尾固定行的模型名语义。

本次只修显示层，不改变解析/fallback 行为本身（frontmatter 笔误仍是静默 fallback，只是现在能从 footer 看出来）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `spawn-agent`: 「执行与返回」的「进度可见」场景新增一条约束——末尾固定行显示的模型名是实际生效的模型，而非 frontmatter 声明的名字。

## Impact

- 代码：`src/spawn-agent.ts`（`SubagentSession` 接口、`runAgent` 里 `result.model` 的来源、`SubagentResult` 初始化）。
- 规范：`openspec/specs/spawn-agent/spec.md`（进度可见场景）。
- 测试：`test/spawn-agent.test.ts`（fake harness 支持 session.model + 新增回归用例）。
- 无 API、配置格式、依赖或沙箱行为变更；`resolveModel` 的解析规则不变。
