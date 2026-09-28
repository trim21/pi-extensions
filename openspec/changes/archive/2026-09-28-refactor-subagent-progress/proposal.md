# Proposal

## Why

spawn-agent 的进度面板是一套有状态的行为：**滚动窗口**（最多 4 行）、**连续工具调用合并**（`read x 2, glob`）、**text 块打断合并**、**thinking 瞬态行**、**footer 永不裁剪**，外加「markdown 标记清理 + 超长折叠到 21 字符 + 换行折成单行」这套进日志前的规范化。它现在以四个可变变量（`logLines` / `toolLineSegments` / `toolLine` / `thinkingChars`）和三个局部函数（`pushLogLine` / `appendToolLine` / `emitUpdate`）散落在 `runAgent` 的闭包里（`src/spawn-agent.ts:481-538`），只能通过跑完整个 `AgentSession` 生命周期（`message_update` / `tool_execution_start` / `message_end` 事件序列）间接驱动。

代价：

- **locality**：`3f0400e`、`a013b5f`、`935e828` 三次改动都落在同一段闭包上，而这段逻辑与 session 建立、prompt、abort、结果收集无关。
- **测试**：`test/spawn-agent.test.ts` 的进度块约 200 行，全部经 `fakeSessionHarness`（`test/spawn-agent.test.ts:630-663`）发事件再断言 toolcall 进度文本；一条「连续同名工具记为 `name x N`」的规则要搭起一整个假 session 才能验。
- **归属**：`foldProgressLine` / `sanitizeProgressLine` / `toolSegment` / `formatUsageStats` 四个纯 helper 与它们的调用者分离，读代码要来回跳。

## What Changes

- 新增 `src/spawn-agent-progress.ts`（与既有的 `src/spawn-agent-agents.ts` 同为 spawn-agent 的兄弟模块）：`createSubagentProgress({ name, maxLines? })` 返回 `SubagentProgress`，暴露 `noteToolCall` / `noteTextBlock` / `thinkingStart` / `thinkingDelta` / `thinkingEnd` / `render(usage, model?)`；滚动窗口、合并规则、瞬态 thinking 行、footer、markdown 清理、折叠与 `formatUsageStats` 随状态一起搬进来。
- `src/spawn-agent.ts` 的 `runAgent` 只剩事件翻译：四个事件分支各调一次 `progress.noteX(...)` 再 `emitUpdate()`；`emitUpdate` 退化为「`progress.render(result.usage, result.model)` → `onUpdate`」。
- 新增 `test/spawn-agent-progress.test.ts`：直接打模块验滚动窗口、合并计数、text 打断合并、thinking 瞬态行、footer 永不裁剪、markdown 清理与折叠。
- `test/spawn-agent.test.ts` 的进度块保持原样（它验的是「事件 → 面板」这条端到端契约，仍然有价值）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无。`spawn-agent` spec 对进度只约束外部可见行为——面板显示子代理名与运行统计、进度滚动、连续工具调用合并——这些都不变，故 `.openspec.yaml` 标记 `skip_specs: true`。）

## Impact

- 代码：新增 `src/spawn-agent-progress.ts`；`src/spawn-agent.ts` 删除四个闭包变量、三个局部函数与五个已搬走的 helper（`MAX_PROGRESS_LINES`、`MAX_PROGRESS_CHARS_PER_LINE`、`PROGRESS_MARKDOWN_MARKERS_RE`、`foldProgressLine`、`sanitizeProgressLine`、`toolSegment`、`formatUsageStats` 搬走；`formatTokens` 搬到模块并导出，因为截断提示（`spawn-agent.ts:730`）也用它）。
- 测试：新增 `test/spawn-agent-progress.test.ts`；`test/spawn-agent.test.ts` 不改。
- 不涉及配置、公开 API、依赖或用户可见行为。
