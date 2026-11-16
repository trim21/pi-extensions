# Tasks

## 1. 依赖与派生层

- [x] 1.1 `pnpm add zod`（4.x）
- [x] 1.2 `src/lib/zod-tool.ts`：`toParametersJsonSchema`（`io: "input"`）、`toOutputJsonSchema`（`io: "output"`）、`zodStructuredResult`、`ZodToolSchema`；派生结果删除 `$schema`

## 2. 总线

- [x] 2.1 `ToolSchema = TSchema | ZodToolSchema`、`ParamsValue` / `StructuredValue` 条件类型
- [x] 2.2 `normalize()`：Zod 参数派生 JSON Schema 并把 `prepareArguments` 包装成 `schema.parse`；Zod 结构化输出派生为输出形态；纯 TypeBox 定义原样保存
- [x] 2.3 `defineStructuredTool` / `StructuredToolDefinition` 接受 `ToolSchema`
- [x] 2.4 `ToolDefinitionWithDefaults` 用 `PiParams<TParams>` 保持 TypeBox 时的渲染器类型

## 3. 工具迁移（按文件并行）

- [x] 3.1 `src/claude-code/`：files / grep / glob / shell / session-tools
- [x] 3.2 `src/opencode/`：files / grep / glob / bash / todo / question
- [x] 3.3 `src/web/`：search / fetch
- [x] 3.4 `src/codemode/tool.ts`、`src/talk/index.ts`
- [x] 3.5 `src/aft/schemas.ts`、`src/aft/tools.ts`
- [x] 3.6 `src/lib/lsp/`：rename-tool / inspect-tool / inspect-schemas；`src/lib/bash-tool.ts`
- [x] 3.7 `src/session-name.ts`、`src/spawn-agent.ts`、`src/vision-agent.ts`
- [x] 3.8 `src/gh/schemas.ts`、`src/gh/base.ts`、`src/gh/tools/*`、`src/lib/github-params.ts`

## 4. 渲染器与类型派生

- [x] 4.1 `src/codemode/declarations.ts`：`renderType` 支持数组形式 `type`（union / nullable）
- [x] 4.2 `src/lib/github-reads.ts`：`ListQuery` 改用 `z.input`（默认值字段可省略），`ListFilterInput` 从 `github-params.ts` 导出

## 5. 测试与文档

- [x] 5.1 `test/zod-tool.test.ts`：派生 JSON Schema（`default` / `required` / 边界 / `@default` 渲染）、默认值补齐、越界拒绝、codemode 路径、结构化结果复核、TypeBox 工具不受影响
- [x] 5.2 `.agents/skills/typebox-schemas/SKILL.md` 改写为「Zod 是工具 schema 的方言」，保留 TypeBox 非工具 schema 一节
- [x] 5.3 `pnpm check`、`pnpm lint`、`pnpm test`：1545 passed，仅既有 `test/lsp-e2e-rename.test.ts` 两条失败（干净 HEAD 复现）
