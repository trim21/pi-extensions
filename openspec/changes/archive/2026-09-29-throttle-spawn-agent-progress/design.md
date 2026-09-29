# Design

## Context

进度推送的现状（见 proposal.md - Why，此处不重复动机）：

- `createSubagentProgress` 是纯状态机：`noteX` 只改状态，读文本靠 `render`，是否推送给宿主由调用方决定（该契约写在 `src/spawn-agent-progress.ts` 头部注释）。
- 调用方 `runAgent` 里的 `emitUpdate` 每次事件都直接调 `onUpdate`，没有合并窗口。
- 仓库已有限流先例：bash 工具在 `src/bwrap/runtime.ts` 用 `throttle(emitUpdate, BASH_UPDATE_THROTTLE_MS, { trailing: true })`，间隔 100ms（对齐 pi 内置 bash 的 100ms）。

## Goals / Non-Goals

**Goals:**

- 进度推送频率上限约 10 次/秒，不受事件密度影响。
- 限流不改变面板最终态：被吞掉的中间帧不影响滚动日志、thinking 行、usage 行的最终内容。
- 与 bash 工具使用同一间隔语义（100ms + trailing）。

**Non-Goals:**

- 不改进度面板的内容、行数或合并规则。
- 不改 `SubagentProgress` 的接口与职责边界（限流属于推送层，不下沉到状态机）。
- 不动 bash 侧已有的限流实现。

## Decisions

**用 lodash-es 的 `throttle(fn, 100, { trailing: true })` 包住 `emitUpdate`，而不是手写 dirty flag + timer。**

- 与 `src/bwrap/runtime.ts` 的现有写法一致，仓库已依赖 `lodash-es`，无新增依赖。
- 备选：照 pi 内置 bash 的 `updateDirty` + `setTimeout` 内联实现。能少一个 import，但要自己维护 dirty 标志与定时器清理；既然仓库已用 lodash 的 throttle，同构写法更好维护。
- 备选：把限流放进 `createSubagentProgress`。否决，那会把「何时推送」的决策交给状态机，破坏它「只改状态」的契约，也让纯状态机的单测被迫处理定时器。

**间隔常量定义在 `src/spawn-agent.ts` 本地，不复用 `BASH_UPDATE_THROTTLE_MS`。**

- bwrap 的那个常量当前未导出，且它的语义是「对齐 pi 内置 bash」；spawn-agent 是「对齐 bash 工具」，同值但理由不同。跨模块导出会让两处的调整互相牵制。
- 备选：抽到 `src/lib/` 作为共享常量。两个使用点、理由不同，暂不值得引入跨扩展共享层。

**结束时不做 `flush()`。**

- tool 返回后进度面板会被最终结果替换，flush 出去的那一帧没有可观察收益。
- trailing 的最后一帧若落在返回之后触发，`render` 读取的仍是闭包中已落定的 `result`，无害——这与 bash 工具现有的 trailing 行为一致。

## Risks / Trade-offs

- [限流窗口内恰好只有一次事件] → 该事件在窗口结束时以 trailing 发出，只是延迟最多 100ms，不丢。
- [trailing 定时器在 `session.dispose()` 之后触发] → `render` 只读取闭包里的 `result.usage` 与 `result.model`，不依赖 session；`onUpdate` 已返回的 tool 上被宿主忽略，不抛错。
- [100ms 让 thinking 字符数显示跳变] → 与 bash 的实时输出体验一致，字符数是累加量，跳变不影响可读性。

## Migration Plan

不涉及数据与配置迁移。改动集中在单个扩展内，回滚即移除 throttle 包装。
