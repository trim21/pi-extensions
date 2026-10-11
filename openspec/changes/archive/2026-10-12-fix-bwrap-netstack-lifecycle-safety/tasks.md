# Tasks

## 1. 进程终止通道（F1）

- [x] 1.1 在 `src/lib/proc.ts` 增加 `childHasExited` / `killChild` / `waitForChildExit`：等待退出基于 `exit` 事件（`AbortSignal.timeout`），并在 `killChild` 注释里写明「按 pid 发信号不是原子的，只作最后手段」。
- [x] 1.2 `src/bwrap/network-stack.ts` 的常规停栈改走 fd 通道（`requestHolderShutdown` 关闭 holder 的 stdin 写端 → holder 读到 EOF 自行退出 → 内核清理 pid namespace → unshare 退出 → exit-fd HUP → slirp4netns 自行退出），全程不按 pid 发信号；仍保留裸 pid 的只有「holder 存活期间读到的 pid ns init pid」强杀兜底。
- [x] 1.3 `stop()` 幂等（`stopResult` 缓存，重复调用返回同一结果）；finalizer 用独立 token 注册并在 `stop()` 里 `unregister`；GC 兜底只关 fd 通道，不按 pid 发信号。
- [x] 1.4 只有 fd 通道超时（进程卡死）才用子进程句柄强杀，之后仍未退出才用「holder 存活期间读到的 pid」强杀；等待退出不再用 `kill(pid, 0)` 轮询。

## 2. 运行期异常退出留档（F2）

- [x] 2.1 `NetworkStack.stop()` 返回 `NetworkStackStopResult`（`exitedEarly` + 可选 `logPath`）：关 fd 之前 holder 已自行退出即 `exitedEarly`，此时用 `writeFailureLog` 把缓冲输出与退出状态落盘。
- [x] 2.2 `src/bwrap/holder.ts` 把 mihomo 的退出码传播为自己的退出码（非零即异常终止），使「过滤进程崩溃」与「holder 正常返回」在宿主侧可区分。
- [x] 2.3 `src/bwrap/sandbox.ts` 把停栈结果里的日志路径并入 `SandboxRunResult.networkStackLog`，并在命令以异常结束时把路径附进错误信息。
- [x] 2.4 `src/bwrap/runtime.ts` 在 `sandboxHint` 上追加网络栈日志路径（`withNetworkStackLog`），命令失败时由上层拼进结果文本。

## 3. egress 接口 fail fast（F3）

- [x] 3.1 `src/bwrap/holder.ts` 检查 `waitFor(tap0Exists)` 的返回值：未就绪时打印原因并以非零码退出，不再继续启动 mihomo。
- [x] 3.2 运行 `pnpm run build:holder` 重建 `src/bwrap/holder.js`，产物含新增分支。

## 4. 测试

- [x] 4.1 `test/proc.test.ts`：「killChild」对存活子进程发信号并使其退出、对已退出的子进程不发信号；「waitForChildExit」已结束立即返回 true、运行中超时返回 false、等待期间退出返回 true。
- [x] 4.2 `test/bwrap-netstack-integration.test.ts`：正常停栈返回 `exitedEarly: false` 且无 `logPath`，重复 `stop()` 返回同一结果（幂等）。
- [x] 4.3 `test/bwrap-netstack-integration.test.ts`：正常停栈全程不调用 `ChildProcess.prototype.kill`（`vi.spyOn` 断言），证明停栈只走 fd 通道。
- [x] 4.4 `test/bwrap-netstack-integration.test.ts`：holder 在停栈前被杀死时 `exitedEarly: true` 且日志落盘、内容含退出原因；egress 接口缺失时 holder 以退出码 1 失败并在 stderr 说明原因。
- [x] 4.5 回归：既有的「停栈清目录」「无残留 holder 进程」「停栈 1 秒内完成」「预览与执行一致」用例继续通过。

## 5. 验证

- [x] 5.1 `pnpm run lint` 与 `pnpm run check`（`tsc --noEmit` + prettier）通过。
- [x] 5.2 `pnpm test` 通过；`RUN_NETSTACK_INTEGRATION=1 pnpm exec vitest run test/bwrap-netstack-integration.test.ts` 在宿主上 9 passed。
- [x] 5.3 `openspec validate --specs` 通过；delta 已合并进 `openspec/specs/bwrap-network/spec.md`。
