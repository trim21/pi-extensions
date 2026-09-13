## 1. 监听范围改为活跃 client root

- [x] 1.1 `lsp.ts` 用 `Map<root, WorkspaceWatcher>` 取代单例 `watcher` / `watcherCwd`：新增 `desiredWatchRoots()`（各 client root 与 cwd 求交、去掉被其他 root 包含的、排序）与 `reconcileWatchers()`（差集 stop/start，保留已有订阅）；`watch.enabled: false` 时不建立；`pnpm vitest run test/lsp-config.test.ts` 通过
- [x] 1.2 接入触发点：`startClient` 注册 client 后、`reload` / `reloadAll` 清理后、`closeAll`、`state.cwd` 变化时调用 reconcile；删除旧的 `stopWatcher` / `watcherCwd` 逻辑，`fanOut` 保持不变

## 2. 测试

- [x] 2.1 `test/lsp-config.test.ts` 的 watcher 用例扩展：单 client root 为 cwd 子目录时只监听该 root（不是 cwd）；两个兄弟 root 各自监听；root 包含关系只监听外层；client 关闭后对应 watcher 停止、其他保留；cwd 变化后按新 cwd 重算
- [x] 2.2 回归：`fan-out 按 cwd / root / 扩展名过滤`、驻留文档外部改动退场与 watcher e2e 全部保持通过，`pnpm test` 全绿

## 3. 文档

- [x] 3.1 `src/skills/lsp-config/SKILL.md` 的 `watch` 说明更新：监听范围 = 活跃服务器项目根（去重、不越 cwd），`ignore` 相对每个被监听 root
- [x] 3.2 `openspec/specs/lsp/spec.md` 的 Implementation 段同步监听范围描述

## 4. 验证

- [x] 4.1 `pnpm check`、`pnpm lint`、`pnpm test` 全部通过，检查最终 diff 无调试代码与无关改动
