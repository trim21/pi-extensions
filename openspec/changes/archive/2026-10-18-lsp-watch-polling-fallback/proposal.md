# Proposal

## Why

大仓库 / 容器环境里 `fs.inotify.max_user_watches` 很容易被耗尽，当前实现遇到 ENOSPC / EMFILE 会直接停掉该 root 的工作区监听直到 `/lsp-reload`，此后工具外改文件不会再触发 `workspace/didChangeWatchedFiles`，服务器诊断会停在旧状态。VS Code 遇到同一问题时会挂起 watch 请求并改用 polling 继续监控，我们应当有等价的降级路径，而不是把功能整体关掉。

## What Changes

- 新增顶层配置 `watch.pollingFallback`（缺省 `true`）与 `watch.pollingIntervalMs`（缺省 5000，沿用 timeoutValue 的字符串时长写法）。
- `watchWorkspace` 在 `@parcel/watcher` 建立订阅或运行期因 ENOSPC / EMFILE 失败时，若 `pollingFallback` 开启，改用 `getEventsSince` + `writeSnapshot` 快照轮询：每 `pollingIntervalMs` 全树扫描一次，diff 结果按现有 created / changed / deleted 语义投递，并一次性提示已降级。
- 快照文件放在系统临时目录并按监听目录 + 进程区分，`stop()` 时删除；轮询失败（快照不可读 / 不可写）时回落到现有的监听器停用与降级提示。
- `pollingFallback: false` 时保持现有行为（资源耗尽即停用该 root）。
- 轮询期间忽略集合（内置清单、`watch.ignore`、gitignore 目录）保持不变。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `lsp`: “工作区文件事件同步”的监听器失败降级路径扩展为资源耗尽时可选地降级到快照轮询，并新增 `watch.pollingFallback` / `watch.pollingIntervalMs` 配置。

## Impact

- 代码：`src/lib/lsp/watcher.ts`（订阅失败转轮询、快照生命周期、防重入）、`src/lib/lsp/lsp.ts`（配置 schema / 缺省值 / 透传与降级提示）。
- 行为：ENOSPC / EMFILE 时不再无条件停用监听，而是继续以轮询方式投递事件（代价是周期性全树扫描）；`pollingFallback: false` 恢复旧行为。
- 依赖：无新增依赖，使用 `@parcel/watcher` 已有的 `getEventsSince` / `writeSnapshot`（`InotifyBackend` 继承 `BruteForceBackend`）。
- 测试：`test/lsp-watcher-polling.test.ts`（mock `subscribe` 抛 ENOSPC，验证轮询事件、降级提示、stop 清理）、`test/lsp-config.test.ts`（配置解析）。
- 文档：`openspec/specs/lsp/spec.md`、`src/skills/lsp-config/SKILL.md`。
