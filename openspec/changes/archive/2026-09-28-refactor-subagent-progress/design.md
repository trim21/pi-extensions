# Design

## Context

现状（重构前，`src/spawn-agent.ts`）：

- 常量：`MAX_PROGRESS_LINES = 4`（`:103`）、`MAX_PROGRESS_CHARS_PER_LINE = 21`（`:105`）、`PROGRESS_MARKDOWN_MARKERS_RE`（`:110`）。
- 纯 helper：`foldProgressLine`（`:240`）、`sanitizeProgressLine`（`:253`）、`formatTokens`（`:257`）、`formatUsageStats`（`:270`）、`toolSegment`（`:378`）。
- 状态与推进（`runAgent` 内，`:481-538`）：`logLines: string[]`、`toolLineSegments: string[]`、`toolLine?: {name, count}`、`thinkingChars?: number`；局部函数 `pushLogLine`（入窗 + 打断合并）、`appendToolLine`（合并 + 重写末行 + emit）、`emitUpdate`（渲染窗口 + 瞬态 thinking 行 + footer，推给 `onUpdate`）。
- 事件映射（`handleEvent`，`:540-575`）：`message_update` 的 `text_end` → `pushLogLine("text: …")` + emit；`thinking_start/delta/end` → 计数 + emit；`tool_execution_start` → `appendToolLine`（内部 emit）；`message_end` → 更新 `result.usage` / `result.model` 后 emit。

关键不变量（必须逐字保留）：

1. 窗口只保留最后 `MAX_PROGRESS_LINES` 行，thinking 行与 footer 在窗口之外。
2. 连续同名工具计为 `name x N`，不同名按调用顺序罗列（`toolSegment` 只在 count > 1 时带 `x N`）；只有写日志行的事件（text 块）打断合并，thinking 不打断。
3. 工具行合并期间是**重写末行**（`logLines[logLines.length - 1] = line`），批内第一次是 push。
4. `thinking ( N chars )` 是瞬态行：位于窗口之后、footer 之前，`thinking_end` 后消失。
5. footer 是 `\`${name}\` ${usageLine}`（usageLine 为空时只有 code span 的 name），永不裁剪。
6. 进日志的内容先 `sanitizeProgressLine`（删 markdown 标记 → 空白折成单空格 → 去首尾），再 `foldProgressLine`（超过 21 字符折叠为 9 + `…` + 9）。

## Goals / Non-Goals

**Goals**

- 进度状态机有单一归属，能脱离 `AgentSession` 直接驱动与断言。
- `runAgent` 退回事件翻译。
- 每个事件 → 面板行的规则可单测。

**Non-Goals**

- 不改任何可见行为：行格式、窗口大小、21 字符折叠、markdown 清理、footer 组合、emit 时机（每次状态变化后一次 `onUpdate`）全都不动。
- 不引入配置项或新的事件类型。
- 不改 `test/spawn-agent.test.ts` 的进度端到端用例。

## Decisions

### D1 新模块是**工厂 + 闭包**，落在 `src/spawn-agent-progress.ts`

```ts
export interface ProgressUsage {
  turns: number;
  cost: number;
  contextTokens: number;
}

export interface SubagentProgress {
  /** 工具调用开始：合并进当前 `tool:` 行。 */
  noteToolCall(rawName: string): void;
  /** 一个完成的 text 块：作为 `text:` 行写入并打断工具合并。 */
  noteTextBlock(content: string): void;
  /** thinking 开始：打开瞬态行（计数从 0 开始）。 */
  thinkingStart(): void;
  /** thinking 增量：累加字符数。 */
  thinkingDelta(length: number): void;
  /** thinking 结束：关闭瞬态行。 */
  thinkingEnd(): void;
  /** 渲染面板：滚动窗口 + 瞬态 thinking 行 + footer。 */
  render(usage: ProgressUsage, model?: string): string;
}

export function createSubagentProgress(options: {
  /** 面板标题（子代理名）。 */
  name: string;
  /** 滚动窗口行数，缺省 4。 */
  maxLines?: number;
}): SubagentProgress;

/** token 计数的可读格式（进度 footer 与输出截断提示共用）。 */
export function formatTokens(count: number): string;
```

- **工厂 + 闭包**（而不是 class）：状态随调用者生命周期，符合仓库「不用模块级可变状态」的约定；一次 run 一个实例。
- **`maxLines` 可注入**：让窗口行为能直接测（测 2 行的窗口比构造 5 个事件流打 4 行窗口清楚）。默认值必须等于 `MAX_PROGRESS_LINES`。
- **`render(usage, model)` 接收 usage 而不是持有它**：usage/model 属于 `runAgent` 的 `result`（由 `message_end` 更新），进度模块只负责渲染；这样模块不依赖 `SubagentResult` 类型，也不需要 getter 注入。
- **`noteX` 不负责推送**：`onUpdate` 的调用留在 `runAgent`（一次事件 → 一次推送），模块保持「改状态 + 返回文本」；与现状的 emit 次数完全一致（每个分支一次）。
- **`formatTokens` 搬到模块并导出**：`spawn-agent.ts:730` 的输出截断提示也用它，留在原文件则模块要反向 import 形成环。导出比复制一份好；`formatUsageStats` 只服务 footer，保持私有。
- **考虑过的替代方案**：
  - 留在 `spawn-agent.ts` 里做成 class：class 语法可行（非 enum/namespace，可擦除），但兄弟模块 `spawn-agent-agents.ts` 已确立「spawn-agent 的配套逻辑单独成文件」的做法，且 743 行的 `spawn-agent.ts` 再进 100 行会进一步稀释工具注册逻辑。选新文件。
  - 让模块直接持有 `onUpdate` 并自己推送：省掉调用方的 `emitUpdate()`，但把「什么时候推送给 TUI」这个 host 关注点塞进状态机，也让 thinking 分支多一条不推送的例外要记。否决。
  - 把 `formatUsageStats`/`formatTokens` 放进 `src/lib/`：那是跨扩展共享层，这两个函数目前只有 spawn-agent 用。否决。

### D2 迁移顺序：纯 helper 先走，状态机跟上，调用方最后

`foldProgressLine` / `sanitizeProgressLine` / `toolSegment` / `formatUsageStats` / `formatTokens` 与三个常量整体搬入模块（内容逐字不动，只改可见性）；随后把四个变量与 `pushLogLine` / `appendToolLine` 改写成模块内部实现（不变量的 1–6 条逐条对应）；最后 `runAgent` 侧删掉变量与三个局部函数，改为：

```ts
const progress = createSubagentProgress({ name: result.agent });
const emitUpdate = () => {
  onUpdate?.({
    content: [{ type: "text", text: progress.render(result.usage, result.model) }],
    details: {},
  });
};
```

事件分支：

```ts
case "text_end":      progress.noteTextBlock(delta.content); emitUpdate(); break;
case "thinking_start": progress.thinkingStart();             emitUpdate(); break;
case "thinking_delta": progress.thinkingDelta(delta.delta.length); emitUpdate(); break;
case "thinking_end":  progress.thinkingEnd();                emitUpdate(); break;
// tool_execution_start
progress.noteToolCall(event.toolName); emitUpdate(); break;
// message_end（更新 usage/model 之后）
emitUpdate();
```

注意 `result.agent` 在构造 `progress` 时已定（`runAgent` 开头写入），而 `result.model` 会被 `message_end` 更新——`render` 每次都用最新值，与现状一致（现状 footer 每次读 `result.model`）。

### D3 新测试只打模块，端到端测试不动

`test/spawn-agent-progress.test.ts` 覆盖：窗口只留最后 N 行（用 `maxLines: 2` 验证）；连续同名工具的 `name x N`；不同名按序罗列且只对连续重复计数；text 块打断合并（下一批另起一行）；thinking 瞬态行出现在 footer 上方、`thinkingEnd` 后消失且不占窗口；footer 恒为最后一行且在窗口滚动中不被挤掉；markdown 标记被清理、换行折成单行、超长内容折叠为 9 + `…` + 9。

`test/spawn-agent.test.ts:875-1075` 的进度块不改：它验的是「事件序列 → 面板」，与模块单测互补。

## Risks / Trade-offs

- **`noteToolCall` + 外部 `emitUpdate()` 的组合弱于现状的「内部 emit」**：如果有人以后新增一个会写日志行的方法却忘了调用 `emitUpdate`，面板会静默不刷新。缓解：模块文档注释写明「每个 noteX 之后由调用方推送」；`runAgent` 里四个分支紧邻排列，漏写一眼可见。
- **`formatTokens` 被两个关注点共用**：放进度模块后，`formatTokens` 的改动会同时影响截断提示，注释里标明这层共用关系。
- **窗口语义靠常量名传达**：`maxLines` 只控制日志行，不含 thinking 行与 footer——注释与测试用例名都要写明，避免未来误把 footer 也算进窗口。
