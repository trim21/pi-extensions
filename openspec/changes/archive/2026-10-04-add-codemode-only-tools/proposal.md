# 新增 codemode-only 工具

## Why

`codemode` 的脚本可调用集合与模型可见的工具列表目前是同一个集合：只有经 `bus.register` 交给 `pi.registerTool` 的工具，才既能被模型直接调用、又能进脚本。于是像 gh-readonly 这 18 个工具——它们已经声明了结构化输出、最适合在脚本里批量编排与过滤——只能一直作为 18 个独立工具占着模型的工具列表与系统提示。需要一个机制把这些工具收进 `codemode`，同时不让模型直接看到它们。

## What Changes

- 新增配置字段 `personalExtensions.codemodeOnlyTools`，条目形状与匹配规则和 `disabledTools` / `enabledTools` 完全一致（工具名模式字符串，或 `{ tools, models? }`；minimatch；模型名同时试 `model id` 与 `provider/model`）。
- 总线新增 codemode-only 语义：命中该字段**且声明了 `structuredSchema`** 的工具只进总线自己的注册表（`bus.list()` 可见、`bus.executeTool()` 可调用），**不**交给 `pi.registerTool`。因此它不进模型的工具列表、不进 active 列表、不产生 `promptSnippet`。
- schema 门控：`codemodeOnlyTools` 只对能进 codemode 的工具生效。命中但**没有** `structuredSchema` 的工具（`Read` / `Edit` / `Write`、`Glob` / `Grep`、talk、会话工具等）忽略该规则、照常直接注册，并产生一条可诊断的警告——避免「配了 codemode-only」被静默变成「工具消失」。
- `codemode` 的可调用集合在原有准入条件（声明了 `structuredSchema`）之上，对 codemode-only 工具放行：不再受 active 列表求交的约束；普通直接工具仍与 active 列表求交。
- `disabledTools` 优先级更高：被禁用的工具仍完全不注册，既不可直接调也不可脚本调。
- gh-readonly 全部 18 个工具作为首批：用户 `~/.pi/agent/settings.json` 的 `personalExtensions.codemodeOnlyTools` 加上对应模式。工具实现本身不改。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tool-registration`：启用配置新增 `codemodeOnlyTools`；工具总线新增 codemode-only 注册路径（仅限声明了 `structuredSchema` 的工具，不交给 pi）。
- `codemode`：可调用集合的规则新增 codemode-only 分支，脚本仍只能调用声明了 `structuredSchema` 的工具。

## Impact

- `src/lib/tools-config.ts`：`ToolsConfig`、`ToolRuleField`、`resolveToolAvailability`。
- `src/lib/tool-bus.ts`：`ToolBusOptions`、`RegisteredToolDefinition`、`register`。
- `src/lib/tool-registration.ts`：把 `isCodemodeOnly` 接进总线。
- `src/codemode/tool.ts`：`collectTools` 的集合规则。
- `test/tools-config.test.ts`、`test/tool-bus.test.ts`、`test/codemode-tool.test.ts`。
- `README.md` / `AGENTS.md` 的配置说明；用户 `~/.pi/agent/settings.json`（不在仓库内）。
- 不引入新依赖，不改 pi 版本。
