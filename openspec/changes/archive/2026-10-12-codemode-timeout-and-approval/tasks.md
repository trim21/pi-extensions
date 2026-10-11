# Tasks

## 1. `timeout_ms` 的解析

- [x] 1.1 `src/codemode/source.ts` 的 `SUPPORTED_FIELDS` 增加 `timeout_ms`，校验为正整数且 ≤ 2147483647（零、负数、小数、非数字都报错），解析结果放进 `CodemodeSourceOptions.timeoutMs`；`test/codemode-tool.test.ts` 覆盖这些非法值与合法值
- [x] 1.2 `src/codemode/tool.ts` 保持单参数（`code`）与 `constrainedSampling` grammar（多参数在支持 grammar 的模型上会被静默忽略或直接报错），把解析出的 `timeoutMs` 传给 `sandbox.run`

## 2. 超时收尾

- [x] 2.1 `src/codemode/protocol.ts` 的 `ScriptErrorKind` 增加 `"timeout"`
- [x] 2.2 `src/codemode/sandbox.ts`：`SandboxRunOptions` 增加 `timeoutMs?`；`onCall` 的请求带上传给工具的合成信号（调用方 signal 与内部超时 signal 用 `AbortSignal.any` 合成）；超时定时器到点后 `finish({ ok: false, error: { kind: "timeout" } })` + `worker.terminate()`，`finish()` 里清掉定时器。验证：`test/codemode.test.ts` 新增用例覆盖 ① `await sleep(5)` + `timeout_ms: 500` 以 `kind: "timeout"` 结束且保留已产生的输出（预算要明显大于 worker 启动时间，否则并行跑会 flaky）；② `while (true) {}` + 超时能结束；③ 超时到点时正在跑的 `onCall` 收到中止信号；④ 不声明 `timeout_ms` 时慢脚本照常跑完
- [x] 2.3 `src/codemode/tool.ts` 的嵌套调用改用 `onCall` 传进来的信号（而不是外层 `signal`），并对超时结果给出可读的失败文本；`test/codemode-tool.test.ts` 覆盖"超时后工具结果是以超时为原因的失败，且已产生的输出与调用记录仍在"

## 3. codemode 内不弹审批

- [x] 3.1 `src/lib/tool-bus.ts` 增加 `ToolCallOptions`，把 `RegisteredToolDefinition` / `StructuredToolDefinition` 的 `execute` 放宽一个可选参数；`executeCodemodeTool` 传 `{ unapprovable: true }`（pi 路径不传）
- [x] 3.2 两套 `Bash` 把 `callOptions.unapprovable` 透传给 `BwrapRuntime.execute`，`src/codemode/fs.ts` 把它透传给 `guardWriteAccess`；`test/bwrap-runtime.test.ts` 与 `test/write-guard.test.ts` 断言该标志下直接拒绝、审批 UI 从未被调用
- [x] 3.3 `src/bwrap/runtime.ts` 的 `approveFullAccess` 增加 `unapprovable` 入参并给出专门文案（说明需要授权、请直接调用 `Bash`）
- [x] 3.4 `src/lib/write-guard.ts` 的 `WriteGuardOptions` 增加 `unapprovable` 并给出专门文案；`test/codemode-tool.test.ts` 覆盖"脚本 `fs.write` 到工作区外直接失败、不弹审批"，以及"模型直调同一工具时审批照常可用"（回归保护）

## 4. 文案与产物

- [x] 4.1 `src/codemode/prelude.ts` 的 `stalled()` 文案改成与 `sleep` 一致的表述（保留 "can never settle" 短语），`test/codemode.test.ts` 对应断言通过
- [x] 4.2 `pnpm run build:codemode-worker` 重建 `src/codemode/worker.js`，`git diff --stat src/codemode/worker.js` 显示产物更新且「worker 产物」用例通过

## 5. 文档与整体验证

- [x] 5.1 `README.md` 的 codemode 段补 `timeout_ms` 与"脚本内需要授权的调用直接失败"两条说明，验证描述与实际行为一致
- [x] 5.2 `pnpm check`、`pnpm lint`、`pnpm test` 全绿

## Workflow follow-up

- 归档已完成：delta 已合并进 `openspec/specs/codemode/spec.md`（超时与审批两条行为都在测试里覆盖）。
