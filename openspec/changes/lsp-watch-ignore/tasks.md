# Tasks — lsp-watch-ignore

## 1. watcher.ts 内核层排除

- [ ] 1.1 在 `src/lib/lsp/watcher.ts` 将 `DEFAULT_IGNORE` 调整为目录名形态的单一来源，新增派生函数为每条 pattern 追加去掉尾部 `/**` 的目录形态并去重；注释说明 Node `ignore` 选项的 matchBase / nonegate 语义差异。验证：`pnpm check` 通过。
- [ ] 1.2 `watchWorkspace` 的 `watch(dir, { recursive: true, signal })` 增加 `ignore: 派生列表`（内核层），事件层 `isIgnored` 改用派生后列表；运行期错误仍走 `onError` 降级。验证：现有 watcher 测试通过。

## 2. 测试

- [ ] 2.1 迁移 / 修正 `test/` 下 watcher 现有用例以匹配派生 pattern 的行为。验证：`pnpm test` 对应文件全绿。
- [ ] 2.2 新增用例：ignored 目录（含 `lsp.json` 配置追加项）内创建文件不产生任何批次回调（内核层不 watch 的行为等价断言）；ignored 目录内监听期间新建子目录 / 文件不产生事件且监听器保持运行。验证：新用例先在未实现时失败、实现后通过。
- [ ] 2.3 新增用例：非 ignored 目录事件照常投递（回归保护），`watch.ignore` 配置项从 lsp.ts 透传后对内核层生效。验证：`pnpm test` 全绿。

## 3. 全量验证

- [ ] 3.1 运行 `pnpm check` 与 `pnpm lint` 全绿；`pnpm test` 全量通过。
- [ ] 3.2 真机冒烟：在含大型 `.git` 的仓库启动 pi agent（重启使扩展生效），确认无 ENOSPC 崩溃、`/proc/<pid>/fd` 中 inotify watch 数量显著下降（或 `sudo lsof | grep inotify` 对比）。验证：崩溃不再复现。
