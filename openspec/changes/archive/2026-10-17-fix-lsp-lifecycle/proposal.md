# Proposal

## Why

LSP 服务有两处与 spec 不一致：

1. 文件监听器只在资源耗尽（ENOSPC / EMFILE）时关闭并移出监听表；其他启动/运行期失败只提示一次，watcher 仍留在表里，后续 reconcile 会因 `watchers.has(root)` 跳过重建，该 root 永久收不到文件事件。
2. `ConfigAdapter.spawn` 在 `bin` 缺失时直接返回，未执行配置的 `setup` 命令；spec 要求 setup 在解析 bin 之前无条件执行。

## What Changes

- 监听器任何失败都先关闭并移出监听表；资源耗尽仍标记为「直到 `/lsp-reload` 不再重建」，其他失败在下一次 reconcile 时重建。提示按 root 去重，重建成功后允许再次提示。
- `spawn` 先执行 `setup`（使用已解析的 `env`），再检查 `bin`；没有 `bin` 时 setup 仍执行，随后返回「不可用」。
- 补回归测试：非 ENOSPC 失败后重建、只有 setup 没有 bin 时 setup 仍执行。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无，两处都是让实现回到既有 spec）

## Impact

- 代码：`src/lib/lsp/lsp.ts`、`src/lib/lsp/server-config.ts`。
- 测试：`test/lsp-config.test.ts`、`test/lsp-server-config.test.ts`。
