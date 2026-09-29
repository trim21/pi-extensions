# Proposal: add-codemode

## Why

模型要读十个文件才能回答一个问题时，现在是十次工具往返：每次往返都把文件内容塞进上下文，再把模型拉回来决定下一步。`codemode` 让模型写一段脚本，把「读什么、怎么筛、怎么并行」交给代码，只有脚本的输出进上下文——这是 pi 内置 `codemode`、codex Code Mode、opencode 的同类能力共同解决的问题。

pi 的内置版本要 0.99 的 `exposure` / `prepareLoadout` / `ctx.executeTool` 才能接进 agent loop；我们已经在 `unify-tool-registration` 里落地了自己的工具总线（`src/lib/tool-bus.ts` 的 `executeTool`），所以这三样都不再需要：派发走总线，工具描述在注册时按总线快照生成，注册时机本来就是每个会话启动。整套能力因此可以完全落在本仓库里，不依赖升 pi。

## What Changes

- 新增工具 `codemode`：入参是一段 JavaScript，在与 pi 同进程的 worker 线程里、由本仓库自带的 QuickJS wasm VM 执行（`quickjs-wasi` 是唯一新依赖）。
- 脚本里的 `tools.<name>(args)` → 主线程 `bus.executeTool(name, args, { ctx, signal })`：走的是各工具自己的实现，所以工具内部的审批（写工作区外的 write-guard、Bash 的沙箱提权等）照常弹 UI；codemode 不额外加确认层。
- 可调用集合 = 总线上实际注册的工具减去 `codemode` 自身，执行时再与 `pi.getActiveTools()` 求交；工具描述（TS 声明）在注册时按这个集合渲染。
- 脚本接口：`tools` / `ALL_TOOLS` / `text` / `image` / `exit` / `console.*` / `store` / `load`，支持顶层 `await` 与 `return`，首行可选 `// @options: {"max_output_tokens":…}`。
- `store` 写在 session 自定义 entry 上（随分支走），输出超预算时头尾截断并把全文落到临时文件。

## Impact

- 新增依赖：`quickjs-wasi`。
- 新增构建产物：`src/codemode/worker.js`（esbuild bundle，随仓库提交，pre-commit 重新构建，与 `src/bwrap/holder.js` 同一套路）。
- 新增代码：`src/codemode/`（prelude / worker / sandbox / protocol / wasm / source / declarations / tool），并在 `src/index.ts` 里注册。
- 新增测试：`test/codemode.test.ts`（沙箱）、`test/codemode-tool.test.ts`（工具层）。
- 不影响既有工具与其审批：codemode 只调它们的 `execute`。
