# Proposal

## Why

codemode 脚本目前只能用 `await tools.<name>(args)` 调工具，返回值是把 toolcall 输出（`content`）拍平成的字符串（`src/codemode/tool.ts` 的 `onCall` 用 `toolResultText(result)`）。gh-readonly 工具里已经算好的机器可读数据——`read-github-pr-status` 的 checks 数组、`read-github-ci-logs` 的 step 行号、`get-github-workflow-jobs` 的 job 列表——要么只以 JSON 文本出现、要么只落在不上桥的 `details` 里，脚本拿不到对象，只能对着文本解析。同时 `declarations.ts` 把每个工具都渲染成 `Promise<unknown>`，模型在写脚本前看不到返回值结构。

脚本入口 `tools.<name>(args)` 按属性名分发，返回类型也只能统一声明成 `unknown`，无从携带每个工具自己的返回结构。

## What Changes

- **BREAKING**：脚本 API 从 `tools.<name>(args)` 改为 `call(name, args)`，`ALL_TOOLS` 保留；`tools` 对象与内部 jsName 别名去掉，工具名就是 `call` 的第一个参数。
- 工具总线新增可选 `structuredSchema`（TypeBox schema，注册时声明）与结果上的 `structuredResult`。它是 `{ ok: true; value }` / `{ ok: false; error }` 的 Result：`value` 由 `structuredSchema` 在编译期约束类型（`defineStructuredTool` 泛型）、总线在运行期用 `Value.Parse` 复核；`{ ok: false }` 让工具不必抛异常也能结构化地报告失败，且不改变面向模型的 `isError` 语义。Result 只嵌在一个属性里，工具结果对象本身仍是单一类型（两个互斥字段会让整个结果变成对象联合）。
- codemode 的 `call()` 在 `structuredResult.ok === true` 时把 `value` 解包交给脚本，`ok === false` 时在脚本内 reject（与工具抛出的异常走同一个 catch 路径）；没有 `structuredResult` 的工具回退现有文本。
- 两个字段名是本仓库自己的约定，刻意不占用宿主字段：pi-agent-core >= 0.99 的 `AgentToolResult` 自带 `structuredContent`、`AgentTool` 自带 `outputSchema`（语义是裸载荷 + 用 `isError` 表失败），沿用会与宿主类型冲突，也会把 Result 信封塞进宿主定义为裸载荷的字段。
- `structuredResult` 只面向 codemode 脚本：MUST NOT 改变工具面向模型的 `content`、既有 `details` 或 `isError` 语义。
- codemode 的工具描述改为渲染一串 `declare function call(...)` 重载：每个工具一行，参数类型与返回类型都来自它的 schema，模型在调用前就能看到返回值类型；未声明 `structuredSchema` 的工具返回类型为 `string`。
- 首期为 gh-readonly 中已经带 JSON payload 的 10 个工具补 `structuredSchema` 与 `structuredResult`：`read-github-issue`、`read-github-pr`、`read-github-issue-comments`、`read-github-pr-comments`、`read-github-pr-status`、`get-github-workflow-jobs`、`read-github-ci-logs`、`download-github-release-assets`、`wait-github-pr-checks`、`wait-github-commit-checks`。其中 `read-github-ci-logs` 的「job 不存在 / 仍在排队」与 `download-github-release-assets` 的「release 没有资产」改用 `{ ok: false }` 表达。
- 其余工具（gh 里纯文本渲染的 `list-*` / `read-repo` / `read-release` / `read-pr-diff` / `watch-github-run`、内置文件工具集、aft 等）继续走文本回退，可按同一机制后续补。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `codemode`: 脚本接口由 `tools.<name>(args)` 改为 `call(name, args)`；工具描述为每个可调用工具渲染参数与返回类型；嵌套调用的返回值语义改为「结果带 `structuredResult` 时，`ok: true` 解包 `value`、`ok: false` 以错误失败，否则返回文本」。
- `gh-readonly`: 首期 10 个工具额外携带与其 JSON payload 同源的 `structuredResult`（Result），供 codemode 脚本直接取用；其中两个工具的「未找到」类结果改用 `{ ok: false }` 表达；工具面向模型的输出与 `isError` 不变。

## Impact

- 代码：`src/codemode/prelude.ts`（脚本侧 `call`）、`src/codemode/declarations.ts`（重载渲染）、`src/codemode/protocol.ts`（ScriptTool 去 jsName、加 structuredSchema）、`src/codemode/tool.ts`（onCall 返回值、描述文案）、重建产物 `src/codemode/worker.js`、`src/lib/tool-bus.ts`（`StructuredResult` 类型、structuredSchema / structuredResult 通道、`defineStructuredTool`）。
- gh 侧：`src/gh/base.ts`（`ToolResult` 加 `structuredResult`，结果构造 helper）与上述 10 个 `src/gh/tools/*.ts`（每个工具的输出 schema 与结构化结果），必要时新增共享 schema 模块。
- 文档：`README.md` 的 codemode 段落。
- 测试：`test/codemode-tool.test.ts`、`test/codemode.test.ts` 的 API 与返回值断言；gh tools 的结构化载荷断言（`test/gh-*.test.ts`）。
- 行为：codemode 脚本侧是破坏性 API 变更；模型直接调用这些 gh 工具的 toolcall 输出（`content`）与 `details` 不变。
