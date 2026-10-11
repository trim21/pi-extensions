# Tasks

## 1. 沙箱内的 sleep

- [x] 1.1 `prelude.ts` 增加 `sleep(seconds)`：参数校验（不是非负有限数就抛 `TypeError`）、复用现有 `pending` 表、`bridge("sleep", id, ms)`；在返回对象上增加 `timerDone(id)`（重放 `settle` 的成功分支）。`pnpm vitest run test/codemode.test.ts` 验证 `await sleep(0.05)` 后脚本继续执行
- [x] 1.2 `worker.ts` 的 bridge 增加 `case "sleep"`：取出 `id` / `ms`，`setTimeout` 回调里以 try/catch 调用 `timerDone(id)` 再 `drain()`（VM 已中止时吞掉异常，与现有 `port.on("message")` 一致）。同一条测试通过
- [x] 1.3 `test/codemode.test.ts` 补用例：`sleep(-1)` / `sleep(Number.NaN)` / `sleep("2")` 抛 `TypeError` 且不是 `CallFailedError`；sleep 期间不产生输出与 toolcall 进度；`Promise.all([sleep(0.02), call("Read", …)])` 正常结束（不死锁）。`pnpm vitest run test/codemode.test.ts` 通过

## 2. 脚本声明与工具描述

- [x] 2.1 `declarations.ts` 的全局声明块增加 `declare function sleep(seconds: number): Promise<void>;`，并补断言：描述里包含该行、脚本里 `sleep` 存在且不在 `ALL_TOOLS` 里（用例落在 `test/codemode-tool.test.ts`，那里有 description 与脚本运行的 harness）
- [x] 2.2 `tool.ts` 的 codemode 描述补一句：脚本需要等待时用 `sleep(seconds)`，不要用 `call("Bash", { command: "sleep …" })`。`pnpm vitest run test/codemode.test.ts` 通过

## 3. worker 产物

- [x] 3.1 `pnpm run build:codemode-worker` 重建 `src/codemode/worker.js`，验证 `git diff --stat src/codemode/worker.js` 显示产物已更新
- [x] 3.2 「worker 产物」回归测试覆盖 sleep：产物里带上 prelude 的 sleep 实现（忘记重建即失败），`pnpm vitest run test/codemode.test.ts` 通过

## 4. 整体验证

- [x] 4.1 `pnpm check`、`pnpm lint`、`pnpm test` 全绿（98 files / 1441 tests passed）
- [ ] 4.2 人工确认：重启 pi 后用一段真实脚本 `await sleep(1); text("done")` 观察结果只含 `done`、进度帧没有 sleep 相关条目

## Workflow follow-up

- 实现完成后用 openspec-archive-change 把 delta 合并进 `openspec/specs/codemode/spec.md` 并归档本 change。
