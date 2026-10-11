# Proposal

## Why

`network: limited` 模式的网络栈是「每条命令现建现停」，一天要重复几百轮进程生命周期。审查这段生命周期管理发现三个缺陷：

1. **停栈后仍会按裸 pid 发信号（误杀风险）**：`stop()` 只 kill 进程、不注销 GC 兜底，`stackFinalizer` 在 stack 对象被回收时会对同一批 pid 再发一次信号；`killProcess` 直接用 `process.kill(pid, ...)`，无法区分「我的子进程」和「pid 被复用后的无关进程」。holder 走 SIGKILL，打错对象就是宿主上任意进程（其他 agent 会话、构建进程）被强杀。启动失败清理（`catch`）与 `stop()` 里对可能已自行退出的 slirp 也是一样。
2. **运行期异常退出不留档**：holder/slirp 的输出只收进内存缓冲，仅在**启动失败**时落盘；命令执行到一半 mihomo/holder 崩溃时，进程树静默消失、缓冲丢弃，用户只看到连接超时，没有任何可定位的材料。
3. **egress 接口未就绪时错误归因错**：`holder.ts` 丢弃 `waitFor(tap0Exists)` 的返回值，tap0 没建起来照样启动 mihomo（出站绑定 `interface-name: tap0`），于是必然打不出就绪日志，宿主侧 20 秒后报 `Timed out waiting for mihomo to start`——真正的原因（slirp4netns 没建 tap0）既没被快速报出，也没出现在日志里。

此外 `waitForExit` 用 `kill(pid, 0)` 轮询判活，pid 被复用时会白等满 2 秒。

## What Changes

- **信号只发给自己的子进程句柄**：`stop()`、启动失败清理与 GC 兜底一律通过 `ChildProcess` 句柄发信号，发之前判 `exitCode`/`signalCode`（已退出的子进程不再收到信号）；裸 pid 只保留给「holder 未退出时」读取到的 pid-ns init 兜底（holder 存活 ⇒ 这些 pid 必然仍属它，不存在复用窗口）。
- **停栈幂等 + 注销兜底**：`stop()` 加 `stopped` 标志；注册 finalizer 时带独立 token，`stop()` 里注销，正常路径不再触发第二次 kill。
- **等子进程退出改为事件驱动**：`waitForChildExit(child, timeoutMs)` 用 `exit` 事件 + 超时，替代 `kill(pid, 0)` 轮询。
- **运行期异常退出被识别并留档**：holder 把 mihomo 的退出码传播出去；`stop()` 在发信号前发现 holder 已自行退出时，把缓冲输出落盘，并把结果（`{ exitedEarly, logPath? }`）返回给调用方；调用方在命令失败时把日志路径附进错误信息，成功时不打扰用户。
- **egress 接口 fail fast**：`holder.ts` 检查 tap0 等待结果，未就绪立刻打印原因并以非零码退出——宿主侧的 exit 监听会立刻把它变成一条可诊断的启动失败，不再等满 mihomo 超时。
- 同步更新 `openspec/specs/bwrap-network/spec.md`（生命周期管理、就绪检测两个 requirement 的场景，新增运行期诊断留档 requirement）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap-network`：
  - 「网络栈生命周期管理」补三项约束——信号必须限定在自己的子进程句柄上（禁止对可能已被复用的 pid 发信号）、停栈必须幂等、正常停栈后 GC 兜底必须已注销且不得再发信号；新增运行期异常退出的识别场景。
  - 「就绪检测」补 egress 接口（tap0）未就绪时立即失败并说明原因，不得继续启动过滤进程、也不得把失败呈现为过滤进程超时。
  - 新增「运行期失败诊断留档」：异常终止时把过滤进程输出落盘并把路径交给调用方，命令失败时该路径必须呈现给用户。

## Impact

- 代码：`src/bwrap/network-stack.ts`（信号路径、幂等、finalizer、`stop()` 返回值、异常退出检测与落盘）、`src/bwrap/holder.ts`（tap0 fail fast、传播 mihomo 退出码）及其构建产物 `src/bwrap/holder.js`、`src/bwrap/sandbox.ts`（透传停栈结果）、`src/bwrap/runtime.ts`（命令失败时附日志路径）。
- 规范：`openspec/specs/bwrap-network/spec.md`。
- 测试：`src/lib/proc.ts` 或 `src/bwrap/` 的纯逻辑单测（`waitForChildExit` / 已退出子进程不发信号 / 幂等）、`test/bwrap-sandbox.test.ts`（透传）、`test/bwrap-netstack-integration.test.ts`（真实 mihomo 下的停栈结果与重复停栈）。
- 不涉及配置格式、依赖与公共工具 API 变更；`network: block` / `allow-all`、宿主崩溃清理、内核对 pid namespace 的清理机制均不变。
