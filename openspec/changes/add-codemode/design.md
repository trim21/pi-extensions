# Design

## Context

- 我们有自己的工具总线（`src/lib/tool-bus.ts`）：`register` / `list` / `declaredNames` / `get` / `executeTool(name, args, { ctx, signal })`，`executeTool` 用工具自身的 schema 校验参数、把校验失败与抛错归一化成错误结果。
- 各工具的审批写在工具实现内部（`guardWriteAccess` 由 Read/Edit/Write/lsp-rename 的 `execute` 直接调用，Bash 的沙箱提权在 `BwrapRuntime.execute` 内部），所以「直接调用 `execute`」天然保留这些审批。
- pi 0.87.1 没有 `ctx.executeTool` / `exposure` / `prepareLoadout` / `defaultActive`；工具在 `session_start` 里注册（每次会话启动重建扩展）。
- 参考实现（pi 内置 codemode）：运行时包 `@earendil-works/pi-codemode`（QuickJS wasm + worker + prelude，零 pi 依赖）+ 扩展侧接线（描述、`ctx.executeTool` 派发、store、输出预算、`details.calls` 进度）。

## Decisions

**1. 自研 QuickJS 宿主，不用 `@earendil-works/pi-codemode`。**

依赖只留 `quickjs-wasi`（vercel-labs 的 QuickJS-NG wasi 构建，pi 用的也是它）。prelude / worker / 中断策略都是我们的代码，脚本侧想改就改（例如只暴露只读工具、加自己的 helper）。

- 备选：直接用那个包（少写约 300 行 prelude）。否决理由：用户明确要自研；且它的脚本接口与 pi 的内置行为绑定，我们要按自己的需要调整时反而更绕。

**2. VM 跑在同进程的 worker 线程里。**

隔离由 QuickJS VM 本身提供：没有 `process` / `require` / `fetch` / 文件 API / timer / 模块加载 / `WebAssembly`，脚本唯一的出口是注入的工具（而工具由主线程执行）。worker 提供的是「可终止」：死循环脚本被 `terminate()` 掉，不阻塞会话。

- 备选：bwrap 子进程（进程级隔离，VM 逃逸也摸不到工作区）。否决理由：每次执行都要起进程并重新编译 wasm（编译结果跨进程传不了），还要自写双工协议与进程组回收；换来的是「VM 自身有漏洞」这一层的边际保护，而脚本本来就不直接碰文件系统。

**3. 一次执行一个 worker + 一个新 VM。**

跑完（或被终止）即丢，执行之间不共享任何 VM 状态；`store` 是唯一的跨调用通道。

- 备选：常驻 worker 复用 VM。否决：跨执行的状态泄漏风险不值得省那点实例化开销。

**4. wasm 在注册工具时编译一次。**

`createCodemodeSandbox()` 在注册流程里 `await` 一次 `WebAssembly.compile`，拿到 `WebAssembly.Module` 存在闭包里；每次执行把它经 `workerData` 传给新 worker（模块可以跨线程结构化克隆），worker 只做实例化。这样注册阶段不建进程、不建连接，但编译只发生一次。

**5. 嵌套调用走 `bus.executeTool`，审批交给各工具自己。**

脚本里的调用与模型直接调用走同一段实现，因此 write-guard / Bash 提权等弹窗照常出现；codemode 不再加一层「逐次确认」。没有 UI 的会话同样由各工具自己的逻辑决定（该拒的拒）。

- 备选：codemode 自己对写类调用逐次确认。否决理由：工具已经审批过一次，再弹一层是重复劳动，且会让「脚本里改了十个文件」变成二十次点击。

**6. 可调用集合 = 总线上除 `codemode` 自身之外的全部工具，执行时再与 active 列表求交。**

`pi.getActiveTools()` 拿不到（或为空）时不过滤——子代理、`--tools` 白名单等场景下由 pi 自己的工具表决定。

**7. 工具描述在注册时按总线快照生成。**

渲染成 TS 声明（`declare const tools: {...}`）写进 `codemode` 的工具描述。pi 用 `prepareLoadout` 每次请求重算，我们没有这个机制；代价是同一会话内后期才注册的工具（LSP 那几个）不在描述里——但脚本仍能调用它们。

**8. `store` 落在 session 自定义 entry 上。**

`codemode-store` entry 记录 `{ set, delete }`，读时从分支根重放，失败脚本的写入丢弃。跟随分支（rewind / fork）自然一致，且不需要额外的持久化机制。

**9. 输出预算：默认 10000 tokens，超限头尾截断，全文落临时文件。**

与 pi 一致：估计 4 字符/token，超预算时保留头尾并提示全文路径（`tmpdir()/pi-codemode-*.txt`）。返回值按 `text()` 的规则追加成文本。

**10. 中断用主线程 `terminate()`，不做共享内存中断标志。**

每次执行都是新 worker，`terminate()` 就是彻底且干净的中止；脚本没有超时（等用户审批不该被判超时，剩下的死循环靠中止即可），所以也不必引入 SharedArrayBuffer 中断标志。所有路径（成功、失败、中止）都 `terminate()`，不留线程。

**11. worker 产物用 esbuild bundle 成 `worker.js` 提交。**

worker 必须以文件路径启动，而源码目录里的 `.ts` 因为内部相对导入写的是 `.js` 后缀、在源码树下无法直接跑（`src/bwrap/holder.js` 同理）。`build:codemode-worker` 把它 bundle 成单文件（依赖保持 external），pre-commit 里重新构建。

**12. `// @options:` 与语法约束采样。**

首行可选 `// @options: {"max_output_tokens":…}`，解析后该行留空以保持行号；同时导出 Lark 语法给 `constrainedSampling`，让支持语法约束的 provider 直接吐裸 JS，而不是 JSON 转义过的字符串。

## Risks

- 脚本里的工具调用不走 pi 的 `tool_call` / `tool_result` 钩子，也没有 pi 的嵌套调用遥测；这是「用总线派发」的代价。
- 脚本内的调用不会在会话记录里留下工具调用条目（只有脚本输出的内容进上下文），出错时靠 `details.calls` 与结果里的调用摘要回溯。
- `quickjs-wasi` 的 wasm 编译在注册阶段发生（约几十毫秒量级）；若它与某个 provider 的启动路径冲突，可退回到「首次调用时编译」。
