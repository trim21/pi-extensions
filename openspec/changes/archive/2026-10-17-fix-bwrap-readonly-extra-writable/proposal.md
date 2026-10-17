# Proposal

## Why

`readonly` 模式目前只清空 `fs.writablePaths`，`fs.extraWritablePaths` 仍会以 `--bind-try` 挂成可写，配置了额外可写路径的会话切到 `/bwrap-fs-readonly` 后仍能写这些路径。`bwrap` spec 的「readonly 模式禁止任何写入」写的是「默认与配置的可写路径都清空」，代码与 README 的「`extraWritablePaths` 仍是显式开口」偏离了 spec。

## What Changes

- `resolveBwrap` 在 `fs.mode === "readonly"` 时同时清空 `extraWritablePaths`；其余模式下保持配置值。
- README 的 fs 模式表同步：readonly 忽略全部可写路径。
- 补回归测试：解析结果为空、`buildBwrapArgs` 不产生额外 `--bind-try`、真实沙箱下额外可写路径仍写不进去。
- spec delta 把「配置的可写路径」明确为 `writablePaths` 与 `extraWritablePaths`，并新增「额外可写路径不生效」场景。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap`：「沙箱模式控制可写边界」明确 readonly MUST 同时忽略 `writablePaths` 与 `extraWritablePaths`。

## Impact

- 代码：`src/bwrap/core.ts`（`resolveBwrap`）。
- 文档：`README.md`。
- 测试：`test/bwrap.test.ts`、`test/bwrap-sandbox.test.ts`。
- 不涉及配置格式、依赖或公共 API 变更；`workspace-write` / `allow-all` 的行为不变。
