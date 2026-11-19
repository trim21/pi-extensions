# Proposal

## Why

工具集默认导出（`claudeCodeFileTools` / `opencodeFileTools`）在注册时无条件经 `createToolRegistration(pi)` 读真实用户 `~/.pi/agent/settings.json`，且没有暴露 `createToolRegistration` 已有的 `settingsPath` 注入参数。走默认导出以覆盖真实注册路径的 e2e 测试因此与本机用户配置耦合：本机 `settings.json` 配置 `fileIoReadTracking: false` 时，`lsp-e2e-rename` 在 CI 绿的情况下本地稳定失败（`details.reads` 断言拿到空）；用户本机的 `disabledTools` / 全局 `lsp.json` 同样会悄悄改变这些测试的行为。

## What Changes

- `ClaudeCodeFileToolOptions` / `OpencodeFileToolOptions` 增加 `settingsPath?: string`，两个默认导出改为 `createToolRegistration(pi, options?.settingsPath)`。生产缺省行为不变（不传时仍读用户 `settings.json`）。
- 6 个走默认导出的 e2e 测试在调用点显式注入隔离路径，不设置、不修改任何环境变量：`settingsPath` 指向必然不存在的文件（沿用 lsp noop service 的惯例），`globalConfigPath`（options 已支持、`...options` 展开直通自建 LspManager）同样注入必然不存在的路径，使 `settings.json` 与全局 `lsp.json` 都不读本机用户文件。涉及 `lsp-e2e-rename` / `lsp-e2e-inspect` / `lsp-e2e-tsls` / `lsp-e2e-gopls` / `lsp-e2e-pyright-ruff` / `opencode-read`。

与 `unify-agent-dir-config-paths`（agent dir 硬编码修复）无实现依赖：注入的是显式路径，绕过默认值解析，那边修不修不影响本 change；两者来自同一次「测试耦合本机配置」的排查。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无——生产缺省行为不变：`settingsPath` 只是把已有的内部注入参数暴露给入口调用方，测试注入路径属测试实现细节。本 change 设 `skip_specs: true`。）

## Impact

- 代码：`src/claude-code/files.ts`、`src/opencode/files.ts`（options 接口 + 默认导出各 2 行透传）；上述 6 个测试文件（调用点传注入 options）。
- 兼容性：生产零变化（不传 `settingsPath` 时行为与现状相同）；测试本地与 CI 行为对齐。
- 无依赖 / API 变化（`createToolRegistration` 的 `settingsPath` 参数已存在；`globalConfigPath` 注入链已存在）。
