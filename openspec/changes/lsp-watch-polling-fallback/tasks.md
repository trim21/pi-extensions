# Tasks

## 1. 轮询实现

- [x] 1.1 `WatchOptions` 增加 `pollingIntervalMs?: number` 与 `onDegraded?: (message: string) => void`；`watchWorkspace` 在订阅失败/运行期错误命中 ENOSPC、EMFILE、No space left on device 时改为快照轮询（`writeSnapshot` 建基线、定时 `getEventsSince` + 重写快照），其他错误仍走 `onError`；验证：`test/lsp-watcher-polling.test.ts` mock `subscribe` 抛 ENOSPC，断言事件仍按 created / changed / deleted 投递
- [x] 1.2 轮询防重入与失败回落：上一轮未完成时跳过本轮；快照读写失败时停止轮询并调用 `onError`；`stop()` 清理定时器与快照文件；验证：同一测试文件断言 `onDegraded` 只调用一次、`stop` 后不再回调且快照文件被删除

## 2. 配置与接线

- [x] 2.1 `watchConfigSchema` 增加 `pollingFallback`（缺省 true）与 `pollingIntervalMs`（缺省 5000，支持 timeoutValue 字符串），`EffectiveWatchConfig` 与 `resolveConfig` 透传；`test/lsp-config.test.ts` 覆盖缺省值、显式关闭与本地覆盖
- [x] 2.2 `startWatcher` 透传 `pollingIntervalMs` 并实现 `onDegraded` 提示（一次性、不加入 `watcherFailed`）；`pollingFallback: false` 时不传轮询选项；验证：`test/lsp-config.test.ts` 断言 `watchWorkspace` 收到的选项与降级提示

## 3. 文档同步

- [x] 3.1 更新 `openspec/specs/lsp/spec.md` 的 `## Implementation`：配置解析段补 `pollingFallback` / `pollingIntervalMs`，文件监听段说明 ENOSPC 降级到轮询、快照生命周期与恢复方式
- [x] 3.2 更新 `src/skills/lsp-config/SKILL.md` 的 watch 段：补充两个字段、轮询代价、事件延迟与 `/lsp-reload` 恢复方式

## 4. 集成验证

- [x] 4.1 运行 `pnpm test`、`pnpm check`、`pnpm lint` 全绿
- [ ] 4.2 手动验证：把 `fs.inotify.max_user_watches` 临时调低到无法覆盖测试目录（或用 mock 的 ENOSPC 路径），确认提示出现、事件仍投递、`/lsp-reload` 后恢复 inotify 订阅

## Workflow follow-up

- 归档顺序：先归档 `lsp-watch-gitignore`，再归档本 change（两者的 spec delta 都 MODIFIED 同一 requirement，后者已包含前者的场景）。
- 归档前运行 `openspec validate lsp-watch-polling-fallback --strict`。
