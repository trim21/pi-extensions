# Tasks

## 1. codemode 脚本 API 与总线结构化结果

- [x] 1.1 在 `src/lib/tool-bus.ts` 定义 `StructuredResult<T> = { ok: true; value: T } | { ok: false; error: string }`、`StructuredToolDefinition`（`structuredSchema: TOutput`，`execute` 返回 `AgentToolResult & { structuredResult: StructuredResult<Static<TOutput>> }`）与 `defineStructuredTool` helper；`ToolBus.register` 接受该类型、`list`/`get` 能读到 `structuredSchema`；总线执行时对 `ok: true` 的 `value` 做 `Value.Parse(structuredSchema, value)` 复核，`pnpm exec tsc --noEmit` 确认现有注册点不受影响
- [x] 1.2 在 `src/codemode/protocol.ts` 的 `ScriptTool` 去掉 `jsName`、加 `structuredSchema`；`src/codemode/declarations.ts` 的 `toScriptTools` 同步
- [x] 1.3 把 `src/codemode/prelude.ts` 的 `tools` 对象换成 `call(name, args)`（名字到 caller 的 Map），保留 `ALL_TOOLS`；定义 `CallFailedError extends Error`（`name` 为 `CallFailedError`）并在 settle 的失败支统一用它 reject；未知名字以它 reject，错误文案与既有「not available」一致
- [x] 1.4 改 `src/codemode/declarations.ts`：每个工具渲染一行 `declare function call(name: "<name>", args: <参数类型>): Promise<<返回类型>>;`，末尾补 `declare function call(name: string, args?: unknown): Promise<unknown>;`；未声明 `structuredSchema` 的工具返回类型为 `string`；`renderType` 补 `const` 分支支持 `Type.Literal` / `StringEnum`；声明里同时给出 `CallFailedError`
- [x] 1.5 改 `src/codemode/tool.ts`：`collectTools` 带上 `structuredSchema`；`onCall` 按 `structuredResult.ok` 解包 `value` 或 reject `error`，没有 `structuredResult` 就回退文本；工具描述与 README 里的 `tools.<name>(args)` 文案改成 `call(name, args)`
- [x] 1.6 运行 `pnpm run build:codemode-worker`（esbuild 单文件产物）重建 `src/codemode/worker.js`
- [x] 1.7 更新 `test/codemode-tool.test.ts` 与 `test/codemode.test.ts`：脚本里的 `tools.X(...)` 改成 `call("X", ...)`，补「未知工具名失败」「ok:true 解包 value」「ok:false reject 成 CallFailedError」「无 structuredResult 回退文本」「描述里每个工具带返回类型」，`vitest run` 通过
- [x] 1.8 更新 `README.md` 的 codemode 段落（API 与返回值语义），`grep -rn "tools\." README.md` 无残留

## 2. gh-readonly 结构化结果

- [x] 2.1 新增 `src/gh/schemas.ts`：共享 TypeBox schema（actor / label / milestone / comment / review / check / job / step / 文件条目 / 两种 view），只对工具本身已依赖的字段设 `required`，允许额外字段
- [x] 2.2 在 `src/gh/base.ts` 给结果类型加 `WithStructured<T>` / `StructuredResultOf<T>` / `StructuredFailure`，并加 `withStructuredResult` / `toStructuredJsonResult`（`Value.Parse`）/ `structuredFailure` 三个 helper；`toToolResult` / `toToolResultJson` 行为不变
- [x] 2.3 给 `read-github-issue` / `read-github-pr` / `read-github-issue-comments` / `read-github-pr-comments` 加 `structuredSchema`（用 `defineStructuredTool`）与 `structuredResult`；`test/pr.test.ts` 断言 content 文本与 `details` 不变而 `structuredResult` 与文本同源
- [x] 2.4 给 `read-github-pr-status` / `get-github-workflow-jobs` / `read-github-ci-logs` / `download-github-release-assets` 加 `structuredSchema` 与 `structuredResult`（复用 handler 里已构造的 payload）；`read-github-ci-logs` 的「job 不存在 / 仍在排队」与 `download-github-release-assets` 的「release 没有资产」改带 `structuredFailure(...)`，文本与 `isError` 不变；`test/pr-status.test.ts` 断言 `structuredResult` 等于文本 payload
- [x] 2.5 在 `waitChecksReport`（`src/gh/base.ts`）里为 `wait-github-pr-checks` / `wait-github-commit-checks` 输出 `{ status, totalChecks, checks, failedJobs }` 的 `structuredResult` 并给两个工具加 `structuredSchema`
- [x] 2.6 跑 gh 相关测试通过（`gh-base` / `pr` / `pr-status` / `gh-readonly-*` / `ci-logs` / `wait-pr-checks`）

## 3. 集成验证

- [x] 3.1 在 `test/codemode-tool.test.ts` 用注入的工具桩覆盖端到端语义：`call()` 拿到 `structuredResult.value` 并直接读字段、`ok: false` 在脚本内成为 `CallFailedError`、`value` 与 `structuredSchema` 不匹配时调用失败
- [x] 3.2 `pnpm check`（`tsc --noEmit` + `prettier --check`）与 `pnpm lint` 全绿
- [x] 3.3 `pnpm test` 全绿（1336 passed / 6 skipped），`openspec validate codemode-call-structured-results --strict` 通过
