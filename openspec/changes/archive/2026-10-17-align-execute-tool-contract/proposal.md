# Proposal

## Why

`tool-registration` 的「工具总线」同时写着两条相反的要求：Requirement 说 `executeTool` 收到 codemode-only 工具名 MUST 报错，旧 Scenario 又说配置路径产生的 codemode-only 工具能被 `executeTool` 执行。两种 codemode-only 工具的形状本来就不同：代码层 `registerCodemodeOnly` 的脚本工具 `execute` 直接返回结构化结果、没有 pi 的 `content` / `details`；配置路径命中的普通工具仍有完整的 pi 结果形状，只是没交给模型。实现只拒绝前者，后者可以正常执行，这与用户的预期一致。

另有一个实现缺陷：`executeTool` 无条件把结果标成 `isError: false`，会吞掉工具自己返回的错误标记，违背「等价于模型直接调用」。

## What Changes

- spec 明确 `executeTool` 只拒绝脚本型 codemode-only（无 pi 结果形状），配置路径的 codemode-only 普通工具可以执行。
- `executeTool` 保留工具结果自身的 `isError`，不再无条件覆盖为 false。
- 补测试：`executeTool` 执行配置路径的 codemode-only 工具、保留工具返回的错误标记；脚本工具仍被拒绝。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tool-registration`：「工具总线」区分两种 codemode-only 工具与 `executeTool` 的适用边界，并修正结果错误标记的契约。

## Impact

- 代码：`src/lib/tool-bus.ts`（`executeTool` 的结果标记）。
- 测试：`test/tool-bus.test.ts`。
- 无配置、依赖或工具清单变更。
