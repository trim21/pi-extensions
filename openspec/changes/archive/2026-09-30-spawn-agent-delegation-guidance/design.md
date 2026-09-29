# Design

## Context

动机见 `proposal.md` 的 Why。约束来自现有实现与加载顺序：

- `spawn-agent` 的 `promptGuidelines` 在扩展加载时构造一次（`createSpawnAgentTool()`），内容依赖 `~/.pi/agent/agents/*.md` 的启动期发现结果，改 agent 文件需要 `/reload`。
- 本仓库的 system prompt 由 `src/system-prompt/` 扩展整体接管：它把 `promptGuidelines` 渲染成 `## Guidelines` 段落（`formatGuidelines`），多行文本原样保留，不做 `- ` 前缀。pi 默认路径（`buildRules`）则会把整段当一个 bullet，两种渲染下多行 Markdown 都仍可读。
- 子 agent 只返回最后一条 assistant 文本（`getFinalOutput`），中间工具调用对父 agent 不可见。
- pi 默认并行派发同一条消息中的多个 tool call，除非工具声明 `executionMode: "sequential"`；`spawn-agent` 未声明，即并发语义已经成立，只是从未对模型说明。

## Goals / Non-Goals

**Goals:**

- 让模型在"该委托"的调研场景下有明确判据，并能给出高质量的自包含任务描述。
- 让 `spawn-agent` 出现在 system prompt 的工具清单里。

**Non-Goals:**

- 不改工具的执行模型（仍为进程内、阻塞到本轮 settle）、返回结构与截断行为。
- 不改 `~/.pi/agent/agents/*.md` 的 frontmatter 与用户级 AGENTS.md（用户配置，不在本仓库范围内）。
- 不新增"子 agent 中途可干预"、结构化返回字段等新能力。

## Decisions

**1. 判据写在 `promptGuidelines` 里，而不是 `src/system-prompt/prompt.md`。**

`formatAgentListSection` 生成的内容本来就要随 agent 清单一起注入，且只对有 `spawn-agent` 的场景有意义；写进 prompt.md 会让所有会话都背着这段文本，也无法和清单保持同一处维护。备选：新增一个独立的 `promptGuidelines` 条目——但那样会多出一个独立段落、与清单分离，且 system prompt 扩展按字母序排序 guideline，两者可能被其它 guideline 隔开。

**2. 判据放在清单之前，保持单一条目。**

`## Guidelines` 里各条目按字母序排列，条目自身内部顺序不受影响，因此把判据段落与 `### Available subagents` 清单放进同一个字符串，可以保证它们始终相邻。

**3. 工具描述改为使用导向，并明说"只返回最终回答"。**

风险点是模型误以为能拿到子 agent 的搜索过程。写清返回契约后，模型能自己判断委托后还需不需要自己复核；配合判据里的"结论只作定位线索"，避免它因为不信任调研结果而干脆不委托。

**4. 不声明 `executionMode: "sequential"`。**

并发是委托调研的主要收益点（多个独立调研点一次发起），保持默认并行。

## Risks / Trade-offs

- [判据文案过长会挤占每个会话的上下文] → 控制在十余行，只保留判据与并发用法，不复述子 agent 的工作方式（那属于各 agent 自己的 system prompt）。
- [模型转而滥用委托，把本可自己读的单文件问题也发出去] → 判据里显式列出"不该委托"的情形（即将自己编辑的单文件、需要逐字原文、任何写操作）。
- [guideline 的排序与其它工具 guideline 混排，位置可能靠后] → 不依赖位置，判据本身自带触发条件；同时用 `promptSnippet` 在工具清单里再出现一次。
- [prompt 措辞效果无法离线断言] → 测试只断言必须出现的关键信息（判据、返回契约、并发语义、清单），措辞效果靠人工在不同提问下观察委托率。

## Open Questions

无。
