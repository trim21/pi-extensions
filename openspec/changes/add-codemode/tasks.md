# Tasks

## 1. 运行时

- [x] 1.1 加依赖 `quickjs-wasi`，加 `build:codemode-worker`（esbuild bundle `src/codemode/worker.ts` → `src/codemode/worker.js`，依赖 external），并把构建放进 `.husky/pre-commit`；验证：`pnpm run build:codemode-worker` 产出文件，`git ls-files` 能看到产物
- [x] 1.2 `src/codemode/prelude.ts`：VM 里先于脚本求值的 JS 源，给出 `tools` / `ALL_TOOLS` / `text` / `image` / `exit` / `console` / `store` / `load`，并把宿主桥接封在闭包里；验证：由 2.2 的用例覆盖
- [x] 1.3 `src/codemode/protocol.ts`：主线程 ↔ worker 的消息类型与 typebox 校验（`start` / `result` 下行，`call` / `output` / `done` 上行）；验证：单测覆盖合法与非法消息
- [x] 1.4 `src/codemode/wasm.ts`：注册时编译一次 `quickjs-wasi/quickjs.wasm`（`WebAssembly.Module`），供 worker 经 workerData 复用；验证：`createCodemodeSandbox()` 两次调用只编译一次（同一模块对象）

## 2. 沙箱

- [x] 2.1 `src/codemode/worker.ts` + `src/codemode/sandbox.ts`：每次执行一个新 worker 与一个新 VM，主线程负责中止时 `terminate()`，并把嵌套调用转发给调用方；验证：2.2 用例覆盖
- [x] 2.2 `test/codemode.test.ts`：工具调用与返回值、`text`/`console` 输出、`store`/`load`、工具报错在脚本内可捕获、不存在的工具、`exit()`、中止终止（保留已产生输出）、永不 settle 的 promise、脚本内无宿主能力；验证：`pnpm exec vitest run test/codemode.test.ts`

## 3. 工具层

- [x] 3.1 `src/codemode/source.ts`：解析首行 `// @options:`（`max_output_tokens`，未知字段报错），保留行号；导出 Lark 语法；验证：单测覆盖正常、非法 JSON、未知字段、只有 options 没有代码
- [x] 3.2 `src/codemode/declarations.ts`：把工具参数 schema 渲染成 TS 声明（object/array/string/number/boolean/union/enum，其余退化为 `unknown`）；验证：单测覆盖嵌套对象与 anyOf
- [x] 3.3 `src/codemode/tool.ts`：注册 `codemode`（描述用 3.2 的渲染结果）、按 `bus.list()` − 自身 ∩ active 计算可调用集合、`onCall` 走 `bus.executeTool` 并透传 `ctx` / `signal`、store 读写、输出预算与全文落盘、`details.calls`；验证：`test/codemode-tool.test.ts` 覆盖描述内容、只读调用、需要审批的调用交给工具自己（fake 工具的 execute 里断言收到 ctx/signal）、未 active 不可调、自身不可调、store 往返、非法 options、失败保留输出
- [x] 3.4 `src/index.ts` 注册 codemode（在其它模块之后，让描述拿到完整工具表）；验证：`test/tool-registration-entry.test.ts` 里断言 `codemode` 出现在工具清单中

## 4. 文档与验收

- [x] 4.1 更新 `README.md` 与 `AGENTS.md`：说明 codemode 的存在、沙箱边界（QuickJS VM + worker）、嵌套调用经工具总线且审批由工具自己负责、worker 产物的构建方式
- [x] 4.2 `pnpm check`、`pnpm lint`、`pnpm test` 全绿；真实会话确认 `codemode` 随其余 41 个工具一起注册（嵌套调用走总线、不额外加确认层由 `test/codemode-tool.test.ts` 覆盖；模型驱动的端到端调用在本机沙箱里跑不了——到 provider 的网络被限制）
