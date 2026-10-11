# Design

## 信号只发给自己的子进程句柄

`stop()` / 启动失败清理 / GC 兜底都改成通过 `ChildProcess` 句柄发信号，发之前判 `exitCode`/`signalCode`（Node 对已退出子进程的 `kill()` 本身也不会发信号，但显式判断让意图可读）。理由：

- Node 没有 `pidfd_open` 的公开 API，无法在发信号前原子校验 pid 身份；而 spawn 出来的句柄本身就是"这是我的子进程"的证明，比记录 pid + 事后比对 `/proc/<pid>/stat` 更简单也更可靠。
- 句柄本来就是 `startNetworkStack` 的局部变量，只需把它放进传给 `stop()` 闭包与 finalizer 的 state 里，不增加生命周期复杂度。
- 裸 pid 只剩一处：`readChildPids` 读到的 pid namespace init pid（PDEATHSIG 未生效时的 SIGKILL 兜底）。它只在「包装进程尚未退出」时可用——此时该 pid 必然仍属本网络栈；`waitForChildExit` 超时返回 false 才用，包装进程已退出则跳过。

## GC 兜底的注销 token 用独立对象

`FinalizationRegistry` 对 unregister token 持**强引用**，所以 token 不能用 target（stack 对象）本身——那会让 stack 永远不可回收，兜底反而永不触发。这里用一个专门的空对象作为 token，`stop()` 里 `unregister(token)`；heldValue 里放 `ChildProcess` 句柄不影响 stack 的回收（heldValue 不引用 target）。

## 停栈结果用返回值，不用回调

现有的 `NetworkStackLog` / `onNetworkStack` 诊断出口目前没有任何调用方（Bash 工具执行层不传），把运行期崩溃路径塞进它等于丢进黑洞。改为 `stop(): Promise<NetworkStackStopResult>`：

```
interface NetworkStackStopResult {
  readonly exitedEarly: boolean;   // holder 在 stop 被调用前已自行退出
  readonly logPath?: string;       // 仅在异常退出且落盘成功时存在
}
```

`sandbox.ts` 把它并入 `SandboxRunResult`，`runtime.ts` 只在命令失败时把日志路径附进错误信息——成功路径不打扰用户（与既有的"超时附输出路径"同一处理方式）。

## 运行期异常退出的判定

判据是「`stop()` 发信号之前 holder 是否已经退出」：此时没有任何人停过它，只可能是它自己（或 pid ns 内的过滤进程）终止了。为了让"mihomo 崩了"与"holder 正常返回"可区分，`holder.ts` 把 mihomo 的退出码传播为自己的退出码（非零即异常）；`stop()` 在已退出且退出码非零时落盘，落盘复用启动失败路径已有的 `writeFailureLog`（同一份日志格式与目录）。

已知竞态：若崩溃与调用方停栈几乎同时发生，holder 可能在判据取到 `exitCode === null` 之后才退出，这一次会被计成正常停栈。判定是尽力而为的——目的不是精确归因，而是"崩溃时不要静默丢日志"。

## tap0 fail fast 放在 holder 侧

`tap0Exists` 的结果由 holder 自己判断：未就绪时打印原因并以非零码退出，宿主侧现成的 exit 监听立刻把它变成一条可诊断的启动失败。宿主侧解析 holder 日志来识别这个失败会引入新的文案耦合（正是「就绪检测依赖 `Tun adapter listening` 字符串」那条隐患的同类问题），不采用。

## 等待子进程退出改为事件驱动

`waitForChildExit(child, timeoutMs)` 用 `exit` 事件 + 超时，替代 `kill(pid, 0)` 轮询：轮询在 pid 被复用后会一直"存活"到超时（每次停栈白等 2 秒），事件驱动既没有这个误判也不需要对已经退出的进程继续等待。

## 风险与不做的事

- 不改内核对 pid namespace 的清理机制、不改 `unshare --kill-child` 的用法、不改配置格式。
- 不引入 pidfd 依赖、不做"pid 复用后仍尝试识别"的身份校验（句柄方案已消除这一类需求）。
- 不把 GC 兜底去掉：它是"调用方忘了停栈"的最后一层保险，只是必须与正常停栈互斥。
