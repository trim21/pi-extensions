# Proposal

## Why

带 thinking 的子 agent 每轮都会先把工具调用拆成独立的一行：实测一次 explorer 运行（14 轮）的进度面板是

```
tool: Read x 4
tool: Bash, Read
tool: Grep, Read
tool: Read x 2
tool: Grep
thinking ( 5976 chars )
`explorer` 14 turns $0.0151 ctx:88k deepseek-v4.1-flash
```

看起来「工具调用合并」完全没生效，其实合并逻辑是对的——是 `thinking_start` 事件（`src/spawn-agent.ts:541`）把 `toolLine` 置为 `undefined`，主动打断了合并：每个 assistant 轮次开头都会先有一段 thinking，于是每轮的工具调用各起一行。thinking 状态行是瞬态的（`thinking_end` 后消失）且不留日志行，所以这些被 thinking 隔开的工具行在面板上直接相邻，用户只能看到一堆割裂的 `tool:` 行。用假 session 复现同一事件序列，输出与线上完全一致（`tool: Read x 4` / `tool: Bash, Read` / `tool: Grep, Read`）。

顺带把日志窗口从 5 行收到 4 行：面板高度按 4 行进度设计，当前窗口多留了一行。

## What Changes

- `thinking_start` 不再打断工具行合并：thinking 不是可见日志行，跨轮次的连续工具调用仍累加到同一 `tool:` 行（`Read x 4, Bash, Read, Grep, Read, …`），文本块（`text:`）仍照旧另起一行。
- 同步修正 `appendToolLine` 附近的合并注释与文件头部的进度日志说明，明确「只有进入滚动窗口的日志行（`text:`）才会打断合并，thinking 不打断」。
- `MAX_PROGRESS_LINES` 从 5 改为 4（滚动窗口只保留最近 4 行日志），并同步文件头部说明与相关测试。
- `test/spawn-agent.test.ts` 补一条回归测试：工具调用 / thinking / 工具调用的事件序列最终只有一行 `tool:` 且包含两批工具；现有滚动窗口用例按 4 行窗口更新。
- `openspec/specs/spawn-agent/spec.md` 的进度可见场景补上实际的进度日志语义（合并规则、文本块另起一行、thinking 瞬态字符数、4 行滚动窗口 + 固定 footer）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `spawn-agent`: 「执行与返回」的进度可见场景现在明确工具调用行的合并规则（同一 run 内连续工具调用合并为一行，thinking 不打断合并，只有文本块另起一行）与滚动窗口大小（最近 4 行）。

## Impact

- 代码：`src/spawn-agent.ts`（`handleEvent` 的 `thinking_start` 分支、`MAX_PROGRESS_LINES`、相关注释）。
- 规范：`openspec/specs/spawn-agent/spec.md`（进度可见场景）。
- 测试：`test/spawn-agent.test.ts`（新增合并回归用例 + 更新滚动窗口用例）。
- 无 API、配置格式、依赖或沙箱行为变更；`text:` 行语义不变。
