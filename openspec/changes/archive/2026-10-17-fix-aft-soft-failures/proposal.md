# Proposal

## Why

AFT 工具与既有 spec 有三处不一致：

1. 只有 callgraph 把引擎的否定答案当作软失败；`aft_search` 的 `search_lanes_unavailable`、outline/zoom 的 `symbol_not_found` 会抛成调用失败，违背「软失败仍保持工具执行成功」。
2. 结构化 schema 里 `range.start_line` / `end_line`、`callRef.name` / `line`、outline 文件条目的 `path` / `language` / `lines` 是必填，引擎省略字段时 `Value.Parse` 会让调用失败，违背「引擎字段一律可选」。
3. `guidelines.md` 无条件把模型指向条件注册的 `aft_search`，默认配置下会引用不存在的工具。

## What Changes

- 定义共享的软失败码集合（`symbol_not_found` / `callgraph_building` / `search_lanes_unavailable`），outline / zoom / search 都传给 `callAftTool`。
- 把上述引擎字段改为可选，保留 `additionalProperties: true`。
- guidelines 只列始终注册的 `aft_outline` / `aft_zoom` / `aft_callgraph`。
- 补测试：省略字段仍通过复核、三个工具都传软失败码。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无，三处都是让实现回到既有 spec）

## Impact

- 代码：`src/aft/tools.ts`、`src/aft/schemas.ts`、`src/aft/guidelines.md`。
- 测试：`test/aft-structured.test.ts`。
