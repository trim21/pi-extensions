# Proposal

## Why

`spawn-agent` 的 toolcall 进度推送没有限流：每次子代理事件都直接调用宿主的 `onUpdate`。其中 `thinking_delta` 是按流式 chunk 触发的，一次长 thinking 会产生几百到几千次面板重渲染和 UI 推送，与同为流式进度的 bash 工具（100ms 限流）行为不一致，也让 TUI 做大量无意义的重复刷新。

## What Changes

- `spawn-agent` 的进度推送加上与 bash 工具一致的 100ms 限流（trailing 语义：窗口内最后一次事件的状态必定送达）。
- 面板内容与结构不变：被合并掉的只是中间帧，子代理名、usage、thinking 行、滚动日志行的最终态照常刷新。
- 无新增参数、无 API 变更、无破坏性变更。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `spawn-agent`: 「进度可见」这条 requirement 增加进度推送的限流约束。

## Impact

- 代码：`src/spawn-agent.ts` 的 `emitUpdate`。
- 复用 `src/bwrap/runtime.ts` 已有的 100ms 限流间隔（`BASH_UPDATE_THROTTLE_MS`）；`lodash-es` 已在依赖中。
- 测试：`test/spawn-agent.test.ts`（进度推送频率）。
- 用户可见行为：进度面板刷新频率从「每事件一次」变为「最多每 100ms 一次」，最终态不变。
