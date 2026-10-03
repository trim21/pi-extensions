# Design

## Context

见 `proposal.md`。约束与既有事实：

- 今天 codemode 的三层结构：`tool.ts`（注册与编排）、`sandbox.ts`（worker 线程客户端）、`worker.ts` + `prelude.ts`（worker 内的 QuickJS VM 与脚本侧 API），协议走 worker 的 `postMessage`，产物 `worker.js` 由 esbuild 打出并随仓库提交。
- bwrap 层已经成熟且被 Bash 工具使用：`resolveBwrap` 解析配置（fs 模式、可写路径、只读保护、network 模式），`buildBwrapInvocation` 组装 argv 与干净 env，`execInvocation` 负责 spawn、进程组、超时、中止、`nsenter` 前缀（network=limited 时进 holder netns）。这些都在 `src/bwrap/`，与 codemode 无关的部分不用改。
- `src/lib/request-policy.ts` 提供「本会话是否禁止提权请求」的判断，`src/lib/write-guard.ts` 是写类工具审批的既有实现（含 headless / Windows 的 fail-closed 分支）。
- 本机实测（Linux，bwrap + node 子进程 + fd 3 协议）：冷启动中位数 22 ms（范围 20–24），一次工具调用往返 0.026 ms；`--ro-bind / / --dev /dev --proc /proc --unshare-net` 下 `fs.writeFileSync` 到 `/tmp` 与 `$HOME` 都是 EROFS、外网 ENETUNREACH；杀掉 bwrap pid 会带走子进程。

## Goals / Non-Goals

**Goals:**

- 脚本跑在真 Node 里，文件操作用 `node:fs` 就够，我们不再维护第二套文件 API。
- 沙箱边界与 Bash 完全同一份配置，不新增第二套策略；没有沙箱时也不静默放行。
- 宿主与脚本之间只有一条可校验的协议通道，脚本的任何 stdout/stderr 输出都不会破坏它。
- 每次执行一个全新运行时，跑完即回收；不引入跨调用的常驻状态。

**Non-Goals:**

- 跨调用常驻子进程、跨调用保留脚本内状态（今天的 `store` 仍是唯一的持久机制）。
- 脚本侧的模块加载：不提供 `require` / `import()` 入口，脚本只能用宿主注入的接口与 Node 内置能力。
- 给脚本加超时（维持现状：只受调用方中止约束）。
- 沙箱不可用平台上的「等同 bwrap」方案（Linux 之外没有等价物，只做授权后的无沙箱执行）。
- 把 bwrap 层泛化成通用「跑任意进程」API：只做到让 codemode 复用同一份配置与生命周期。

## Decisions

### D1：每次调用新起一个子进程

用户已定：与今天一致——每次 `codemode` 调用 spawn 一个 `bwrap … node <脚本>`，结束即杀进程组。

放弃常驻子进程：脚本状态跨调用保留的收益小于要处理的泄漏、会话切换回收、以及「上一个脚本的残留影响下一个脚本」。放弃 worker 线程（今天的选择）：Node 的文件系统、原生模块、真栈都是我们这次想要的东西，而它们只有进程级隔离才能安全回收（线程里的死循环要用 `Worker.terminate()`，进程里用杀进程组）。

### D2：沙箱配置整体复用 Bash 的那一份

`codemode` 拿到的就是 `resolveBwrap` 的解析结果（`ResolvedBwrap`），与 Bash 用同一个对象；fs 模式、可写路径、只读保护、network 模式一律跟随。脚本因此与沙箱里的 Bash 有完全相同的读写与出网边界（用户已定「跟宿主当前模式相同」）。

为此把 `src/bwrap/exec.ts` 的命令组装从「bash 字符串」泛化为 argv：`BwrapInvocation` 里放 `commandArgv: string[]`，Bash 传 `[shell, "-lc", command]`，codemode 传 `[nodePath, scriptPath, workspace]`。`invocationArgv` / `--print-args` / 集成测试仍共用同一份组装，因此预览与实际执行不会漂移。`network: limited` 时沿用 `execInvocation` 的 `nsenter` 前缀（进 holder 的 netns），即脚本也能访问 allowlist 内的地址。

### D3：协议走一条全双工专用 fd，stdio 全归脚本

spawn 的 stdio 里额外开一个 fd（`CHILD_FRAME_FD = 3`）：Node 为 `stdio` 里多出来的管道建的是 **socketpair**，本来就是全双工，因此两个方向共用它一条——宿主发 `start` / `result`，子进程发 `ready` / `call` / `output` / `done`，分帧一致（magic + 十进制长度 + `:` + JSON 文本）。

stdin/stdout/stderr 于是完全归脚本：stdin 是 `/dev/null`（协议不占用它，脚本也不该读宿主的输入），stdout/stderr 由宿主收集成脚本输出项（`console.*` 由 bootstrap 注入的代理走协议帧，因此与 `text()` 严格同序；直接 `process.stdout.write` 或原生模块的打印走管道，宿主照收）。协议与脚本输出绝不共用一个 fd——`process.stdout.write` 拦不住原生写入，共用就永远存在「某个库写半行插进帧中间」的窗口。

实测确认：fd 3 是 socketpair（`isSocket=true`），穿过 bwrap 后仍可双向读写；子进程往 stdout 写 5 MB 噪声（含伪造的协议帧）时，协议通道只有 2 帧 51 字节，解析零污染。

帧同步：magic 用控制字符 0x1e 包住（普通文本里几乎不可能出现），宿主按 magic 重新同步——脚本是模型自己的代码，这里防的是意外（例如脚本往协议 fd 写东西）而不是攻击；magic 之后的帧体解析不出就杀掉子进程并按「协议损坏」失败。

### D4：bootstrap 用 TS 写、esbuild 转成随仓库提交的产物

子进程入口是 `src/codemode/bootstrap.ts`，由 `pnpm run build:codemode-bootstrap` 转成 `bootstrap.js`（`--format=esm --target=node24`，与 `src/bwrap/holder.ts` → `holder.js` 同一套做法，pre-commit 重新生成并把产物入暂存）。宿主用 `new URL("bootstrap.js", import.meta.url)` 定位它，脚本本体经协议帧传给子进程，因此**不需要临时文件**。

它跑在 pi 进程之外、由 `node` 直接加载，不走 pi 的 jiti 加载器，因此解析不到 pi 提供的依赖（`worker.js` 那个 typebox 事故的根因）。所以它只允许两种 import：`node:` 内置模块，以及 `./protocol.js` 的**类型导入**（转译后完全消失）。回归测试 `test/codemode.test.ts` 的「bootstrap 脚本产物」检查产物里只剩 `node:` 内置导入。

`quickjs-wasi`、`wasm.ts`、`worker.ts` / `worker.js`、`build:codemode-worker` 与 `fs.ts` 一并删除。

脚本本体通过 `new Function` 以注入的接口为参数求值：`call` / `CallFailedError` / `ALL_TOOLS` / `text` / `image` / `exit` / `console` / `store` 是注入值，Node 内置能力（`process`、`node:fs` 等）天然可见。

### D5：执行上限取代卡死检测

真 Node 有 timer 与 socket，宿主无法再靠「VM 里没有 timer」判断脚本挂住了。曾经做过一版子进程内的卡死检测（`process.getActiveResourcesInfo()` 与基线做差集，差集只剩自己的轮询 timer 就判定挂死），但它依赖 libuv 的资源名，是与「加一个真正的超时」重复的机制。

最终做法是：**去掉卡死检测，改成墙钟上限**，缺省 120 s，脚本可用首行 `// @options: {"timeout_ms": …}` 放宽。上限从子进程起好之后开始算，到点杀掉整个进程组，结果以 `kind: "timeout"` 失败，消息里给出当前上限与放宽方式（模型能自己看懂并改脚本）。

墙钟上限之所以在过去不可行、现在可行：它会把「等人」的时间也算进去，而脚本里的嵌套调用以前可能停在用户审批上（写工作区外的文件、Bash 提权），用户思考多久都算脚本的运行时间——那时超时看起来就像 bug。现在会等人的工具一律不进可调用集合（`Bash` / `web_fetch` / `lsp-rename` / `AskUserQuestion` / `talk-ask`），脚本里不再有不受脚本控制的等待，超时就是纯粹的执行上限。

保留下来的契约是「挂住的脚本不会把会话挂住」，只是判据从「立刻（250 ms）」变成「到上限」。

实现上上限不另起一套计时：把调用方的中止信号与 `AbortSignal.timeout(timeoutMs)` 用
`AbortSignal.any` 合成一条信号，中止与超时共用同一条收尾路径（杀掉整个进程组），区别只在
错误类型（`aborted` / `timeout`）——`AbortSignal.timeout` 的 timer 本身是 unref 的，不会吊住
pi 的事件循环。

### D6：协议帧的校验与错误归一

子进程 → 宿主的帧用 `protocol.ts` 的 TypeBox schema 校验（防的是子进程的意外输出）。宿主 → 子进程的帧由 bootstrap 手工做形状检查：帧类型固定、id 是数字，因此不需要把 TypeBox 带进子进程（子进程零运行期依赖）。

失败语义不变：`fs` / 工具调用的失败都在脚本侧 reject 成 `CallFailedError`；协议损坏、子进程提前退出、spawn 失败在工具结果里是「沙箱」类失败。

### D6b：会等人的工具不进可调用集合

除原有的排除项（`codemode` 自身、`spawn-agent`、两套文件读写工具）外，再把 `Bash`（沙箱外执行要审批）、`web_fetch`、`lsp-rename`（写审批）与 `AskUserQuestion`、`talk-ask`（等用户或另一个 agent 的回答）排除。理由与 D5 配套：脚本有了墙钟上限，就不该存在「把执行时间交给人」的调用，否则超时会打断用户正在回答的提问。

代价是模型不能在脚本里跑命令或抓网页——它可以直接调这些工具，或把命令拆成多次 codemode 之外的调用；如果模型确实想在脚本里跑一条命令，得先确认这对它是不是真的必要（当前判断是不必要：Bash 是交互式审批的入口，不适合放进编排）。

### D7：无 bwrap 时授权后无沙箱执行

`findBwrap` 找不到可执行文件（非 Linux）或 bwrap 启动失败（用户命名空间被禁）时：先按 `RequestPolicy` 判断本会话是否禁止提权请求（headless、Windows、`/bwrap-deny-request` 生效即拒绝，不弹窗），否则弹一次 Appoval 让用户选择是否以普通子进程执行；用户拒绝则不执行。判定结果按会话缓存（同一会话内不再重复打扰），与 `write-guard` 的审批交互保持一致（选择项与标题风格相同）。脚本本体不因此变化：协议、注入接口、回收方式一致，差别只是没有沙箱。

### D8：嵌套调用在宿主执行，脚本沙箱不约束它

脚本只发出一帧调用请求，工具由 pi 进程执行（`bus.executeTool`），因此**嵌套调用不在脚本的沙箱里跑**：`call("Bash", { command })` 由宿主按会话的沙箱配置新起一个 bwrap（全新 namespace，不是套在脚本的 namespace 里），`call("Bash", { command, dangerouslyDisableSandbox: true })` 走 Bash 自己的门（`/bwrap-deny-request` → 自动审批规则 → 弹框），批准后在宿主上无沙箱执行。

因此「脚本的沙箱」只约束脚本自己直接做的事，不构成嵌套工具的围栏——想做到「嵌套调用也困在脚本沙箱里」不可能，工具是宿主实现（带 UI 与审批）。反过来脚本的沙箱模式也不额外收紧嵌套工具。这条写进了 spec（「嵌套调用的执行」），避免被误读成「codemode 里的 Bash 会跑在 codemode 的沙箱内」。

**不禁用** `dangerouslyDisableSandbox`：那层门本来就是给用户看的，脚本绕不过审批；模型在 codemode 之外也能直接调同一把 Bash，禁掉只会制造「脚本不能提权」的假象。

### D9：与文件工具的记账互锁一并撤掉

脚本改用 `node:fs` 之后，`fs.write` 那套「先读后写 + 工作区外审批」不再存在，#173 为它暴露的 `readonly reads`、`restoreReads` 里的 `"codemode"`、`src/index.ts` 的 policy/reads 注入、以及 codemode 结果里的 `details.reads` 全部撤掉。工具侧的保护不受影响且仍然 fail-closed：脚本直接写过某个文件后，模型再调 `Write` / `Edit` 时 `src/lib/file-reads.ts` 的 `requireCurrentRead` 会以「未读」或「读后被改」拒绝，不会静默覆盖。

## Risks / Trade-offs

- [脚本能力比今天大：能直接在沙箱里读写、出网] → 这正是选它的原因（与 Bash 对齐）；边界写在沙箱配置里，且没有沙箱时必须授权。
- [Linux-only 沙箱] → 非 Linux 走 D7 的授权路径；headless 或策略禁止时 codemode 在这类平台不可用。
- [脚本能读整棵根（含 `~/.ssh` 等）] → 与 Bash 沙箱一致（今天经 `fs.read` 同样可读，只是路径可见）；如需收紧，应在 bwrap 层加统一的 deny 挂载，而不是在 codemode 里做例外。
- [`bootstrap.js` 是随仓库提交的转译产物] → 与 `src/bwrap/holder.js` 同一套约定：pre-commit 重新生成并入暂存，测试里有一条「产物只 import node 内置」守住它不被加上第三方依赖。
- [卡死检测依赖 Node 资源名] → 见 D5，漏报不影响正确性；真挂住的脚本仍可由调用方中止。
- [协议损坏无法 100% 防] → 有 magic + 长度 + 重同步 + 失败即杀；脚本不是攻击者。
- [每次执行新起进程的冷启动 ~22 ms] → 相对一次 LLM 工具调用可忽略；换来的是干净回收。
