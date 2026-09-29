# Proposal

## Why

模型很少把专注的调研任务委托给子 agent，而是自己在主上下文里读完。原因不是模型排斥委托，而是提示词里没有任何一句说明这件事什么时候划算：

- 工具描述（`src/spawn-agent.ts`）只讲「是什么」——隔离 session、进程内、**阻塞**，把唯一被强调的属性写成了成本；没有使用场景。
- `task` 参数的描述是 `"Task to delegate to the subagent"`，既没说子 agent 看不到本对话（必须自包含），也没说该返回什么。
- `promptGuidelines` 里注入的 agent 清单以 `"You can delegate tasks to the following subagent types..."` 开头，是能力清单而非决策规则。
- 工具没有 `promptSnippet`，因此不出现在 system prompt 的 "Available tools" 清单里（本仓库其余绝大多数工具都有）。
- 子 agent 只返回最后一条消息、中间过程不可见，这一点从未写出来；模型无法判断能拿到什么，也就无法判断值不值得。

## What Changes

- `spawn-agent` 的工具描述改为使用导向：说明子 agent 看不到当前对话、只返回最终回答（中间过程不可见）、同一条消息里的多个调用会并发执行。
- `task` 参数描述改为「自包含任务」，要求写明仓库路径、确切问题、期望返回的内容（文件路径 + 行号）。
- 注入的 guideline 从能力清单改为决策规则：先给「该委托 / 不该委托」的判据与并发用法，再列可用子 agent 类型；并写明子 agent 的结论只作为定位线索，动手前须自行核对。
- `spawn-agent` 补 `promptSnippet`，进入 system prompt 的 "Available tools" 清单。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `spawn-agent`: 新增「委托提示词」要求——工具描述与 guideline 必须给出委托判据、返回契约与并发语义。

## Impact

- 代码：`src/spawn-agent.ts`（工具描述、`task` 参数描述、`promptSnippet`、`formatAgentListSection` 的文本）。
- 行为：`spawn-agent` 工具在模型上下文里的描述与 guideline 变化，进入 "Available tools" 清单；工具执行、参数 schema 形状、返回结构均不变。
- 测试：`test/spawn-agent.test.ts` 中 `formatAgentListSection` 与 guideline 注入的断言更新。
- 范围外：用户级 `~/.pi/agent/agents/*.md` 的 `description` 文案与 `~/.pi/agent/AGENTS.md` 的规则不在本变更内。
