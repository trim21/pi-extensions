# Proposal

## Why

gh 工具集有三处行为与 spec 不一致：

1. `download-github-release-assets` 用缓存目录里的文件数判断「release 没有资产」。目录里已有上次缓存的文件时，无资产的 release 会误报成功并列出旧文件。
2. `runGh` 的 SIGKILL 升级用 `proc.killed` 判断，而它在 `kill()` 调用成功后即为 `true`；进程不响应 SIGTERM 时永远不会升级到 SIGKILL，5 秒定时器也没在退出时清理。
3. `read-github-ci-logs` 只把 `queued` 当作「尚未开始」。`waiting` / `requested` / `pending` 等其他未开始状态会继续去下载日志并抛出非结构化错误。

## What Changes

- release 无资产判定改用 release API 返回的资产清单（`view.assets`），不再看缓存目录内容。
- `runGh` 用 `exitCode` / `signalCode` 判断进程是否已退出，超时后仍存活则发送 SIGKILL；退出时清理该定时器。
- CI 日志读取把未开始状态扩展为 `queued` / `waiting` / `requested` / `pending`，统一返回结构化失败并指向 `watch-github-run`。
- 补对应回归测试；spec 行为不变，因此不产生 spec delta。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无，三处都是让实现回到既有 spec）

## Impact

- 代码：`src/gh/tools/download-release-assets.ts`、`src/lib/gh-process.ts`、`src/gh/tools/read-ci-logs.ts`。
- 测试：`test/gh-process.test.ts`、`test/run-gh-timeout.test.ts`、`test/download-release-assets.test.ts`、`test/read-ci-logs.test.ts`（按现有测试文件实际名称调整）。
- 无配置、依赖或工具清单变更。
