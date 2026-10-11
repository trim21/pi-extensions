# Proposal

## Why

脚本里需要「等一下」时没有可用的手段：沙箱没有 `setTimeout`，只能 `await call("Bash", { command: "sleep 5" })`——那要占一次真实的工具调用（走审批、依赖宿主 shell、出现在进度帧与 `ALL_TOOLS` 语义里）。写轮询脚本（等一个进程退出、等文件出现）时尤其别扭。

## What Changes

- 新增脚本全局 `sleep(seconds: number): Promise<void>`：单位是秒，可以是小数（`await sleep(0.5)`），与 `text` / `image` / `store` / `fs` 并列挂在 `globalThis` 上。
- 它由 worker 线程自身的定时器驱动，不经主线程、不产生消息往返、不产生进度帧、也不产生任何输出。
- **不设上限**：脚本想睡多久就睡多久，结束只能靠调用方 abort——与现有「脚本没有超时，只有调用方的中止」语义一致。
- 沙箱里其它 timer（`setTimeout` / `setInterval`）仍不存在；「等一个永远不会 settle 的 promise」的检测不变（sleep 期间 pending 表非空，不会被误判）。
- 声明与描述同步：脚本侧类型声明里加 `declare function sleep(seconds: number): Promise<void>;`，codemode 工具描述里说明它是脚本唯一的等待手段。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `codemode`: 「脚本接口」新增 `sleep(seconds)` 这一项脚本接口与对应 scenario。

## Impact

- 代码：`src/codemode/prelude.ts`（`sleep` 与 self-settle 入口）、`src/codemode/worker.ts`（bridge 的 `sleep` 分支与定时器驱动）、`src/codemode/declarations.ts`（类型声明）、`src/codemode/tool.ts`（描述一行）、`src/codemode/worker.js`（esbuild 产物重建）。
- 不改协议：`src/codemode/protocol.ts` 无新消息，主线程 `src/codemode/sandbox.ts` 完全不知道 sleep 的存在（因此也没有悬挂定时器的清理问题）。
- 测试：`test/codemode.test.ts`。
