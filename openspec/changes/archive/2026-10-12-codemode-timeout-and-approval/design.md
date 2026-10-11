# Design

## Context

- 脚本当前没有任何时长约束，唯一结束方式是调用方中止（`openspec/specs/codemode/spec.md` 的「中止」）。
- 审批（需要用户确认的调用）只有两条真实路径，且都在工具内部：
  - 写工作区外 → [`guardWriteAccess`](/home/trim21/projects/pi-extensions/src/lib/write-guard.ts:149)，弹框在 [:189](/home/trim21/projects/pi-extensions/src/lib/write-guard.ts:189)，无 UI / Windows / `policy.deniesRequests()` 时直接拒绝（[:163-177](/home/trim21/projects/pi-extensions/src/lib/write-guard.ts:163)）。
  - `Bash` 申请沙箱外执行 → [`BwrapRuntime.approveFullAccess`](/home/trim21/projects/pi-extensions/src/bwrap/runtime.ts:704)，真正的拦截点在 [:711](/home/trim21/projects/pi-extensions/src/bwrap/runtime.ts:711)（`!ctx.hasUI` → `UNSANDBOXED_DENIED`）。
  - `web_fetch` 没有网络审批（只有 SSRF 过滤），且它不在 codemode 可调用集合里（没有 `structuredSchema`），文件工具与 `lsp-rename` 同样不在集合里——所以脚本能触发的审批只有上面两条，外加脚本自己的 `fs.write`（同一份 `guardWriteAccess`）。
- 审批入口收到的 ctx 是 pi 的 `ExtensionContext` / `ExtensionToolContext`：类型封闭（无 index signature），但**运行时是每次工具调用新建的普通对象**（`runner.ts` 的 `createContext()` / `createToolContext()`），未被 freeze。
- codemode 的嵌套调用与 `fs` 原语**共享 codemode 那一个 ctx 对象引用**（[tool.ts:370](/home/trim21/projects/pi-extensions/src/codemode/tool.ts:370)、[:385](/home/trim21/projects/pi-extensions/src/codemode/tool.ts:385)、总线原样转发）——而两个模型发起的调用之间不共享。见 proposal.md - Why 了解动机。

## Goals / Non-Goals

**Goals:**

- `// @options: {"timeout_ms": …}` 声明墙钟执行预算（含等待嵌套调用的时间），到点先定结果再收尾。
- codemode 内的嵌套调用不再弹审批：需要授权的调用直接以 `CallFailedError` 失败，且不产生副作用。
- 全部行为在不新增配置字段的前提下成立（预算是脚本声明的，审批策略是 codemode 路径固定的）。

**Non-Goals:**

- 不引入 `interruptHandler` / 中断预算（见 Decisions）。
- 不改会话级的 `/bwrap-deny-request` 语义，也不影响模型直调工具的审批。
- 不给 `timeout_ms` 设默认值（不声明即不设限，见 Decisions）。

## Decisions

**超时放在主线程的 `sandbox.ts`，而不是 worker。**
输出与调用记录本来就收集在主线程（[sandbox.ts:106-107](/home/trim21/projects/pi-extensions/src/codemode/sandbox.ts:106)），`finish()` 会把它们一起返回，所以超时到点只需要主线程做三件事：`finish({ ok: false, error: { kind: "timeout", … } })`、中止正在执行的嵌套调用、`worker.terminate()`。放在 worker 侧不占额外优势，却要多一套 worker 内的收尾路径。

**忙循环靠 `worker.terminate()`，不用 `interruptHandler`。**
Node 的 `terminate()` 能停掉正在执行 JS 的 worker（现有 abort 路径已依赖这一点，`test/codemode.test.ts` 的"死循环被中止终止"用例覆盖）。pi 内置之所以要 `SharedArrayBuffer` + 中断标志，是因为 Bun 的 `terminate()` 停不了计算中的线程（`packages/codemode/src/runtime/host.ts:16`），这是运行时差异。`interruptHandler` 只在"想让脚本自己 catch 到中断并收尾"时有价值，我们不需要复用 VM，先不做。

**超时必须同时中止正在跑的嵌套调用。**
`terminate()` 只杀 worker，主线程里 `await options.onCall(…)` 的那个工具还在跑（Bash 命令会继续执行完，产生副作用）。所以 `SandboxRunOptions.onCall` 的请求里要带上**合成信号**（调用方 signal 与内部超时 signal 合成，`AbortSignal.any`），由 `tool.ts` 传给 `bus.executeCodemodeTool` 的工具。

**`timeout_ms` 与 pi 内置同名同校验，缺省不设限。**
正整数、上限 2147483647（`setTimeout` 的安全上限），未声明时不施加任何上限。给默认值会让"长任务脚本"（如一条两小时的命令）被意外杀掉，而兜底能力已经由 `/bwrap-deny-request` 之外的调用方中止提供；这与现有"脚本没有超时"的默认保持一致，只是把控制权交给脚本作者。

**选项留在脚本首行的 `// @options` 里，codemode 保持单参数。**
把 `timeout_ms` / `max_output_tokens` 变成工具参数看起来更直接（校验来自 tool schema、不用自己解析），但它与 grammar 约束互斥：pi 会把声明了 `constrainedSampling: { type: "grammar" }` 的工具转成 OpenAI 的"单自由文本"custom tool（`packages/ai/src/api/openai-responses-shared.ts:367-379`，JSON schema 整体不参与请求），而 grammar 的输入属性要求"恰好一个 required 字符串属性"（`packages/ai/src/api/constrained-sampling.ts:202-219`）。后果是多出来的参数要么让请求构建直接报错（required 超过一个），要么永远不被模型填写（optional，静默失效）。pi 内置 codemode 就是"单个 `code` 参数 + 注释选项 + grammar"的形态（`packages/coding-agent/src/extensions/codemode/tool.ts:396`），这里跟随它：选项继续由 `parseCodemodeSource` 解析，`constrainedSampling` 保持不变。将来若要改成参数化，必须同时放弃 grammar。

**「不可审批」用 `execute` 的可选调用选项显式传递。**
总线在自己的调用路径（`executeCodemodeTool`）调用工具定义时多传一个参数 `{ unapprovable: true }`；pi 直接调用工具时不会传，值是 `undefined`。`Bash`（两套）把它透传给 bwrap 的 `BwrapExecutionRequest`，脚本的 `fs.write` 把它透传给 `guardWriteAccess` 的 `WriteGuardOptions`，两个审批入口读这个标志直接拒绝并给出"请直接调用该工具"的文案。

- 为什么不用 `hasUI: false`：`hasUI` 是会话事实，改它会让其它依赖 UI 的代码走错分支，错误信息也会变成"没有 UI"这种不准确的解释。
- 为什么不用 `RequestPolicy`：它是会话级单例，改它会连模型直调的审批一起拒掉。
- 为什么不在 ctx 上挂标记：ctx 是 pi 的封闭类型，挂属性只能靠 Symbol + 类型断言，调用链上的意图不可见；显式参数写在类型里（`ToolCallOptions`），读代码就能看到。
- 只有真正会请求审批、又进得了 codemode 集合的工具需要透传：`Bash`（两套）与脚本的 `fs.write`。`Edit` / `Write` 没有 `structuredSchema`，本来就不在集合里，不需要改。

**保留 `stalled`，只修正文案。**
它和超时不重叠：`await new Promise(() => {})` 这类永久挂起能毫秒级失败，不必让模型白等一个预算。文案里"timers do not exist here"在加入 `sleep` 后已经自相矛盾，改成"没有待处理的工具调用与 sleep"。

## Risks / Trade-offs

- [`execute` 多出的第 6 个可选参数超出了 pi 的 `ToolDefinition` 签名] → 只在本仓库自己持有的类型上放宽（`RegisteredToolDefinition` / `StructuredToolDefinition`），pi 调用时少传该参数即可，实现里按可选处理。
- [超时收尾是"硬杀"，脚本没有机会 catch 后自己收尾] → 结果仍带上已产生的输出与完整调用记录（主线程收集），模型能据此判断进度；需要更细的收尾再考虑 `interruptHandler`。
- [codemode 内不可审批会改变模型习惯] → 失败信息明确指向"直接调用该工具"，模型可以直接重发一次直调。
- [超时预算包含等工具的时间] → 与 pi 内置语义一致；等审批的时间已被"不可审批"消掉，剩下的等待都能被脚本作者计入预算。

## Migration Plan

无迁移。行为变化集中在 codemode：默认（不声明 `timeout_ms`）与今天一致，除了"脚本内需要授权的调用从弹审批变成直接失败"。
