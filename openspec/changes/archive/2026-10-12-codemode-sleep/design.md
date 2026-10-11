# Design

## Context

脚本跑在 worker 线程里的 QuickJS VM 中：VM 自身没有事件循环、没有 timer，脚本的异步能力全来自 prelude 的 `pending` 表与一条桥——prelude 通过 `bridge(kind, …)` 把请求交给 worker 的 bridge 函数，worker 用 `postMessage` 转给主线程，主线程执行完回 `{ t: "result", id, … }`，worker 的 `port.on("message")` 收到后调用 prelude 的 `settle(id, …)`，再 `drain()`（`executePendingJobs()` + `stalled()` 判定）推进脚本。

约束：脚本没有超时，结束只能靠调用方中止（`worker.terminate()`）；VM 里 `setTimeout` / `setInterval` 不存在，`stalled()` 在 `pending` 为空时判定"等一个永远不会 settle 的 promise"。见 proposal.md - Why 了解动机，见 spec delta 了解对外行为。

## Goals / Non-Goals

**Goals:**

- 脚本能 `await sleep(seconds)`（秒、可为小数）后继续执行。
- 不引入跨线程往返、不新增协议消息、不产生输出与 toolcall 进度。
- 主线程对 sleep 无感知，因此没有主线程定时器的清理问题。

**Non-Goals:**

- 不给脚本开放通用 timer（`setTimeout` / `setInterval`）。
- 不设上限或超时（用户明确选择）。
- 不在进度帧里显示"脚本正在等待"。
- 不追求与 pi 内置 codemode 沙箱的脚本可移植性（内置没有 sleep）。

## Decisions

**在 worker 线程内用宿主定时器驱动，不经主线程。**
`sleep` 复用 prelude 现有的 `pending` 表，`bridge("sleep", id, ms)` 由 worker 的 bridge 函数捕获后自己 `setTimeout(ms)`，回调里调用 prelude 新导出的 `timerDone(id)`（重放 `settle` 的成功分支：查表、删表、`resolve()`），随后复用现有 `drain()`。

- 备选（主线程驱动）：新增一条 worker→host 消息 `{ t: "sleep", id, ms }`，主线程 `setTimeout` 后回 `{ t: "result", … }`。缺点是多一条协议消息、每次 sleep 多一次跨线程往返，还要在主线程的 `finish()`（正常结束、abort、worker 报错）里 `clearTimeout`，否则留下悬挂定时器。
- 备选（把 timer 暴露给脚本）：宿主定时器回调里要在 VM 内执行脚本回调函数，需要处理 VM 已中止、`setInterval` 清理等语义，复杂度和出错面都大得多。
- 备选（`Atomics.wait` 同步阻塞 worker 线程）：会阻塞 `port.on("message")`，脚本里 `Promise.all([sleep(1), call("Bash")])` 直接死锁，且无法响应中止。

**单位是秒、支持小数。** `await sleep(6)` 与 `await sleep(0.5)` 都自然；内部换算成毫秒。

**不设上限。** 与"脚本没有超时"的既有语义一致（worker.ts 与 protocol.ts 的注释都写着死循环只能靠调用方中止）；代价由风险一节说明。

**参数校验放在 prelude。** 参数不是非负有限数时抛 `TypeError`——sleep 不是工具调用，因此不用 `CallFailedError`。

**`stalled()` 判定不改。** sleep 期间 `pending.size > 0`，本来就不会被误判成"永远不会 settle"。

**声明与描述同步。** `declarations.ts` 增加 `declare function sleep(seconds: number): Promise<void>;`（模型据此知道能用），codemode 的工具描述里补一句它是脚本唯一的等待手段。

## Risks / Trade-offs

- [脚本可以自愿长时间挂起，而 codemode 是 `executionMode: "sequential"`，会把整批工具调用占住] → 接受（用户选择不设上限）；中止走现有 `worker.terminate()`，worker 内已排的定时器随 worker 一起消失，主线程无残留。
- [定时器回调触发时 VM 可能已被中止] → 回调里包 try/catch，与现有 `port.on("message")` 的处理一致；已中止时 `callFunction` 抛错被吞掉。
- [`worker.js` 是 esbuild 产物，忘记重建会让打包后的 sleep 不存在或行为不一致] → 实现任务里包含 `pnpm run build:codemode-worker`，并保留「worker 产物」回归测试的覆盖。
- [使用 sleep 的脚本无法在 pi 内置 codemode 里运行（内置沙箱没有它）] → 已知差异，记录在 skill / 文档措辞里不承诺可移植。

## Migration Plan

无迁移，纯新增能力。回滚等于删掉 `sleep`：用了它的脚本会以 `ReferenceError` 失败，其余行为不变。
