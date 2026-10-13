# Proposal

## Why

`gh` / `spawn-agent` 在环境不支持（Windows）或依赖缺失（`gh` 不在 PATH）时会禁用整个工具集，但「为什么禁用」的提示只写在两个模块的默认导出里。真实会话走的是入口 `src/index.ts`，它调用工厂 `createGithubTools()` / `createSpawnAgentTool()`，拿到 `undefined` 就静默跳过 —— 于是这两条提示在真实会话里从来不出现，用户只看到工具凭空消失，而直接驱动默认导出的测试照旧通过。

## What Changes

- `createGithubTools()` / `createSpawnAgentTool()` 不再返回 `undefined`，而是在不可用时返回一个「只说明原因、不注册任何工具」的模块：它在 `register(bus, ctx)` 里调用 `ctx.ui.notify(原因, level)`，`ctx` 就是入口在 `session_start` 里传进来的那个。
- 两个默认导出随之变薄：只保留 `registerToolsOnSessionStart(pi, (bus, ctx) => tools.register(bus, ctx))`，不再各自挂一份提示 handler。
- 行为变化：不可用提示在**入口路径**上也会出现（此前只有独立 `-e` 加载才会出现）；提示措辞与级别不变（`gh` 缺失是 `error`，Windows 禁用是 `warning`）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tool-registration`：新增「工具集不可用时的提示」—— 环境原因导致工具集不可用时，入口路径 MUST 在会话启动提示一次原因，MUST NOT 静默跳过。

## Impact

- 代码：`src/gh/index.ts`、`src/spawn-agent.ts`（工厂返回值与默认导出）。
- 测试：`test/gh-readonly-setup.test.ts`（取 `session_start` handler 时改为取最后一个：`createToolRegistration` 会先挂一个记录模型的 handler）。
- 不涉及：工具集选择与配置语义、`registerToolsOnSessionStart` 与各模块默认导出（保持现状）、vision 的按模型注册。
