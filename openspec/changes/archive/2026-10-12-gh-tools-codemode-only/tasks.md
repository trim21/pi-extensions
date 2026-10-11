# Tasks

## 1. 总线的 codemode-only 路径

- [x] 1.1 `src/lib/tool-bus.ts`：新增 `CodemodeToolDefinition<TParams, TOutput>`（`execute` 直接返回 `Promise<StructuredResult<Static<TOutput>>>`）与 `defineCodemodeTool`；`ToolBus` 新增 `registerCodemodeOnly(definition)`（登记 declared 名 → `isDisabled` 命中返回 false → 否则标 `codemodeOnly: true` 存进总线、不调 `pi.registerTool`）与 `executeCodemodeTool(name, args, options)`（校验参数 → 执行 → 异常与校验失败归一成 `{ ok: false, error }`；对配置路径转来的普通工具取出其 `structuredResult`，取不到给 `{ ok: false, error }`）。`executeTool` 收到 `codemodeOnly` 的定义时返回明确的错误结果，不再执行它。验证：`pnpm exec tsc --noEmit` 通过。
- [x] 1.2 `test/tool-bus.test.ts`：改成新契约的用例——经 `registerCodemodeOnly` 注册的工具不进 `pi.registerTool`、出现在 `list()` 里带 `codemodeOnly: true`；`executeCodemodeTool` 返回 `{ ok: true, value }`、参数不合法与工具抛错返回 `{ ok: false, error }`；被 `disabledTools` 命中时不注册、执行入口给出「工具不可用」；`executeTool` 对 codemode-only 工具返回错误结果。验证：`pnpm vitest run test/tool-bus.test.ts` 通过。

## 2. codemode 侧改用结构化执行入口

- [x] 2.1 `src/codemode/tool.ts`：`call()` 的实现改调 `bus.executeCodemodeTool(name, args, { ctx, signal })`，删掉「没有 `structuredResult` 就退回拼 `content` 文本」的分支与随之无用的 `toolResultText` import。验证：`pnpm exec tsc --noEmit` 通过。
- [x] 2.2 跑 `pnpm vitest run test/codemode-tool.test.ts test/codemode.test.ts` 确认脚本调用、错误传播（`CallFailedError`）与 declarations 生成不变。

## 3. gh 工具改造成脚本工具

- [x] 3.1 `src/gh/base.ts`：删除文本构造与进度渲染（`truncate` / `toToolResult` / `toToolResultJson` / `withPendant` / `subtitlePendant` / `renderHitList` / `renderPrChecksList` / `renderRunStatus` / `checkDisplayName` / `statusIcon`），把 `withStructuredResult` 改成「给定 value 直接产 `StructuredResult`」的构造器（`toStructuredResult(data, schema)` 替代 `toStructuredJsonResult`）；`renderChecksVerdict` 改为 `checksVerdict`（只给 `status` + `failedJobs`），`waitChecksReport` 去掉 `params` / `pendant` / `onUpdate` / `subject` 参数；`pollPrChecks` 与 `watchRun` 去掉 `onUpdate` 与 `subject`。验证：`pnpm exec tsc --noEmit` 通过。
- [x] 3.2 18 个 `src/gh/tools/*.ts`：改用 `bus.registerCodemodeOnly(defineCodemodeTool({ … }))`，`execute` 只返回 `StructuredResult`（去掉 `content` / `details` / `pendant` / `params` 收尾），删掉 `promptSnippet` / `promptGuidelines`。验证：`rg -n "bus\.register\(" src/gh/` 无结果，`rg -n "content:" src/gh/tools/` 无结果。
- [x] 3.3 `src/gh/schemas.ts` 删 7 个载荷里的 `text` 字段；`src/gh/render.ts` 只留 `parseDiffStats` 与 `DiffStats`/`DiffFileStat`（其余渲染函数删除，或把解析函数移到 `base.ts` 并删掉整个文件）；`src/lib/github.ts` 删 `renderHits`。验证：`rg -n "renderHits|renderReleaseList|renderRunList|renderRepoView|renderReleaseView" src/` 无结果。
- [x] 3.4 测试改写：`test/gh-browse-list.test.ts`、`test/gh-tools-rest.test.ts`、`test/gh-watch-run.test.ts` 等把 `textOf(result)` 断言改成 `result.structuredResult` / 执行入口返回值断言（含成功与 `{ ok: false }` 两种）；`test/gh-readonly-setup.test.ts` 断言 gh 工具都不交给 pi；`test/gh-render.test.ts` 只留 `parseDiffStats` 用例；`test/github-search.test.ts` 去掉 `renderHits` 用例。验证：`pnpm vitest run test/gh-browse-list.test.ts test/gh-tools-rest.test.ts test/gh-watch-run.test.ts test/gh-readonly-setup.test.ts test/gh-render.test.ts test/github-search.test.ts` 通过。

## 4. 文档

- [x] 4.1 `README.md`：gh 工具段落改为「只能经 codemode 调用」，说明结果是结构化对象（没有文本输出）、`disabledTools` 可禁用它们。
- [x] 4.2 `src/skills/github-ci-logs/SKILL.md`：把「调用 `read-github-*` 工具」的用法改成 codemode 脚本（`call(...)` + 读返回值，日志内容用 `fs.read(log_file)`）。验证：`rg -n "read-github|list-github|wait-github|watch-github|get-github" src/skills/github-ci-logs/SKILL.md` 中的用法都带 codemode 语境。

## 5. 集成验证

- [x] 5.1 收尾跑一次 `pnpm exec prettier --write` 格式化改动文件，再跑 `pnpm check`、`pnpm lint`、`pnpm test` 全绿。
- [x] 5.2 手动核对：`bus.list()` 里 gh 工具都带 `codemodeOnly: true`；codemode 的 declarations 里仍有 18 个 gh 工具的参数与返回类型；gh 工具结果里没有 `content` / `details` / `text`。

## Workflow follow-up

- 归档时同步 `openspec/specs/gh-readonly/spec.md` 的 `## Implementation` 段（文本渲染、输出预算的表述）与两个 wait spec 的 Purpose 里提到"报告渲染"的句子。
