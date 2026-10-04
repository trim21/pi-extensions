# Tasks

## 1. 配置层：`codemodeOnlyTools`

- [x] 1.1 `src/lib/tools-config.ts`：`ToolsConfig` 加 `codemodeOnlyTools`，`ToolRuleField` 加该字段，`parseToolsConfig` 复用 `parseToolRules` 解析；在 `test/tools-config.test.ts` 加解析用例（字符串条目、`{ tools, models }` 条目、非法条目警告）并跑通 `pnpm vitest run test/tools-config.test.ts`
- [x] 1.2 `resolveToolAvailability` 加 `isCodemodeOnly(name)`（复用 `ruleMatches`），并让 `unmatchedPatterns` 覆盖新字段；在 `test/tools-config.test.ts` 加按模型命中与未命中、以及 unmatched 上报 `codemodeOnlyTools` 的用例

## 2. 总线：codemode-only 注册路径

- [x] 2.1 `src/lib/tool-bus.ts`：`ToolBusOptions` 加 `isCodemodeOnly`，`RegisteredToolDefinition` 加 `codemodeOnly?: boolean`；`register()` 在禁用检查之后判 codemode-only，并做 schema 门控——命中且 `structuredSchema !== undefined` 时只写 `registered` 表、标 `codemodeOnly: true`、不调用 `pi.registerTool`；命中但没有 schema 时照常交给 pi，并记一条诊断（总线暴露只读的诊断列表，去重）
- [x] 2.2 `src/lib/tool-registration.ts`：把 `isCodemodeOnly` 接进 `createToolBus` 选项，并把总线的诊断接出来；`src/index.ts` 在 `session_start` 注册完成后与 `unmatchedPatterns()` 一并 `ctx.ui.notify` 上报；在 `test/tool-bus.test.ts` 加用例（codemode-only 不触发 `pi.registerTool`、出现在 `list()`/`get()`、`executeTool` 可执行；命中但没有 schema 时照常交给 pi 且产生诊断；显式禁用时两端都没有）并跑通

## 3. codemode 可调用集合

- [x] 3.1 `src/codemode/tool.ts`：`collectTools` 的过滤条件改为 `d.codemodeOnly === true || allowed === undefined || allowed.has(d.name)`，更新头部注释说明 codemode-only 分支
- [x] 3.2 `test/codemode-tool.test.ts`：加用例——codemode-only 工具在 active 列表为空/不含它时仍出现在描述里且脚本可调；非 codemode-only 的非 active 直接工具仍不可调；跑通 `pnpm vitest run test/codemode-tool.test.ts test/codemode.test.ts`

## 4. 首批落地与文档

- [x] 4.1 `~/.pi/agent/settings.json` 的 `personalExtensions.codemodeOnlyTools` 加上 gh-readonly 全部 18 个工具的模式；验证方式：启动会话确认模型工具列表里不再有这些工具，且 `codemode` 描述里仍有它们的声明
- [x] 4.2 `README.md` / `AGENTS.md`：在 `personalExtensions` 配置说明里补 `codemodeOnlyTools` 的语义与示例；验证方式：按文档写出的配置能解析
- [x] 4.3 跑 `pnpm check` 与 `pnpm lint`，确认类型、格式与 lint 全绿
