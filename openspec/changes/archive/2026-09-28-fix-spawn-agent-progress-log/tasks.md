# Tasks

## 1. thinking 不再打断工具行合并

- [x] 1.1 `src/spawn-agent.ts` 的 `thinking_start` 分支去掉 `toolLine = undefined`（只保留 `thinkingChars = 0`），并改掉「思考横跨轮次边界：打断工具行合并」注释；验证：`grep -n "toolLine = undefined" src/spawn-agent.ts` 只剩 `pushLogLine` 一处
- [x] 1.2 同步 `appendToolLine` 上方的合并注释与文件头部进度日志说明：只有进入滚动窗口的日志行（`text:`）打断合并，thinking 不打断；验证：注释与 `handleEvent` 的实际分支逐条对照一致

## 2. 日志窗口收到 4 行

- [x] 2.1 `src/spawn-agent.ts` 的 `MAX_PROGRESS_LINES` 从 5 改为 4，并同步文件头部「keeping the last `MAX_PROGRESS_LINES` lines」附近对面板行数的说明（4 行日志 + 瞬态 thinking + 固定 metadata）；验证：`grep -n "MAX_PROGRESS_LINES = " src/spawn-agent.ts` 为 4，注释与实际行数一致

## 3. 回归测试

- [x] 3.1 `test/spawn-agent.test.ts` 的 `subagent progress log` 下新增用例：工具调用 → thinking_start/delta/end → 工具调用的事件序列最终只有一行 `tool:`、且同时含两批工具（如 `tool: read x 2, grep`）；验证：先按当前实现跑该用例确认失败（输出为两行 `tool:`），再应用 1.1 后通过
- [x] 3.2 更新「keeps only the most recent 5 log lines」用例为 4 行窗口（预期 4 行日志 + footer，被挤掉的是最早两行）；验证：`pnpm exec vitest run test/spawn-agent.test.ts` 全绿，且「starts a fresh tool line after a text block」用例不受影响

## 4. 验证与规范

- [x] 4.1 规范同步：`openspec/specs/spawn-agent/spec.md` 的「进度可见」场景按 delta 内容更新（thinking 不打断合并、4 行滚动窗口、面板最多 6 行与折叠规则）；验证：与 `src/spawn-agent.ts` 实现逐条对照无出入
- [x] 4.2 跑 `pnpm check`、`pnpm lint`、`pnpm test` 全绿（改动完成后再统一跑一次 prettier）；验证：三条命令均无报错
