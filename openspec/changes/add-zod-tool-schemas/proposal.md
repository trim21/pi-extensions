# Proposal

## Why

工具参数与结构化输出原先只能用 TypeBox 声明，而 TypeBox 的 `default` 只是注解、`Static` 只给输入类型，于是仓库自己补了 `Default()` / `StaticDefaulted` 与总线泛型这一套（见已归档的 `infer-schema-defaults`）。Zod 把这些当成一等语义：`.default()` 输入可省略、`z.output` 就是解析后的类型，`z.toJSONSchema` 还能直接产出 pi 与 codemode 需要的 JSON Schema。

## What Changes

- 新增依赖 `zod`（4.x）。工具（`bus.register` / `bus.registerCodemodeOnly` / `defineStructuredTool`）的 `parameters` 与 `structuredSchema` 改为 Zod 声明，全部现有工具迁移完成。
- `src/lib/tool-bus.ts` 的 `ToolSchema = TSchema | ZodToolSchema`：注册时把 Zod schema 派生为 JSON Schema（参数 `io: "input"`、结构化输出 `io: "output"`，去掉 `$schema`）交给 pi 与 codemode 声明渲染器，并把定义上的 `prepareArguments` 换成「先跑工具自己的（若有），再 `schema.parse`」——pi 与总线都在 schema 校验前调用它，因此 `.default()`、边界与错误信息全部来自 Zod。
- handler 参数类型为 `z.output<TParams>`；结构化结果用 `src/lib/zod-tool.ts` 的 `zodStructuredResult(schema, value)` 构造。
- `defineStructuredTool` / `StructuredToolDefinition` 接受 `ToolSchema`，`execute` 参数与 `structuredResult` 载荷分别用 `ParamsValue` / `StructuredValue` 定型。
- `src/codemode/declarations.ts` 的 `renderType` 支持 Zod 派生的数组形式 `type`（`["string","null"]`、`["number","string"]`）。
- 非工具 schema（配置解析、协议、引擎响应）仍用 TypeBox + `Value.Parse`，不在本次范围。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `tool-registration`: 工具参数与结构化输出可用 Zod 声明；总线派生 JSON Schema 并把解析交给 `prepareArguments`，默认值以 Zod schema 为唯一来源。
- `codemode`: 声明渲染器支持 Zod 派生的数组形式 `type`。

## Impact

- `package.json` / `pnpm-lock.yaml`：新增 `zod`。
- `src/lib/tool-bus.ts`、`src/lib/zod-tool.ts`（新增）、`src/codemode/declarations.ts`。
- 全部工具模块（`src/aft`、`src/claude-code`、`src/opencode`、`src/gh`、`src/web`、`src/talk`、`src/codemode/tool.ts`、`src/lib/lsp/*`、`src/lib/bash-tool.ts`、`src/session-name.ts`、`src/spawn-agent.ts`、`src/vision-agent.ts`）。
- `.agents/skills/typebox-schemas/SKILL.md` 改写为「Zod 是工具 schema 的方言」。
