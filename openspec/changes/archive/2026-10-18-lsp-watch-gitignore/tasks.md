# Tasks

## 1. gitignore 目录计算

- [x] 1.1 新增 `src/lib/lsp/gitignore.ts` 的 `gitignoredDirectories(root)`：执行 `git -C <root> ls-files --others --ignored --exclude-standard --directory -z`，3s 超时、有界输出，只返回整体被忽略目录的 POSIX 相对路径；非 git / git 缺失 / 失败 / 超时返回空数组；含 glob 元字符（`*?[]{}()!`）的目录跳过
- [x] 1.2 新增 `test/lsp-gitignore.test.ts`：临时 git 仓库覆盖整体忽略目录、嵌套 `.gitignore`、父目录取反不生效、单文件忽略不返回、含 glob 元字符的目录被跳过、非仓库返回空、不存在目录返回空；`pnpm vitest run test/lsp-gitignore.test.ts` 通过

## 2. 监听器接入

- [x] 2.1 `WatchOptions` 增加 `ignoreDirs?: string[]`（绝对路径，仅传给 `@parcel/watcher`），并把它并入 `subscribe` 的 `ignore`；验证：`test/lsp-watcher.test.ts` 新增用例断言 `ignoreDirs` 内新建文件不产生事件

## 3. 内置忽略扩充

- [x] 3.1 `DEFAULT_IGNORE` 增加 `__pycache__`、`.mypy_cache`、`.pytest_cache`、`.ruff_cache`、`.cache`、`.next`、`.turbo`、`.gradle`、`.tox`、`.nox`、`.idea`，不加入 `out` / `bin` / `obj`；验证：`test/lsp-watcher.test.ts` 新增用例断言这些目录不产生事件、`keep.txt` 照常产生事件

## 4. 配置与接线

- [x] 4.1 `watchConfigSchema` 增加 `useGitignore`，`watchDefaults` 缺省 `true`，`EffectiveWatchConfig` 与 `resolveConfig` 透传；`test/lsp-config.test.ts` 覆盖缺省开启、显式关闭、本地覆盖全局
- [x] 4.2 `startWatcher` 在 `useGitignore` 为真时调用 `gitignoredDirectories(root)`，把结果经 `ignoreDirs` 传给 `watchWorkspace`；失败时忽略集合为空且监听器照常启动
- [x] 4.3 `.gitignore` 事件触发该 root 的监听器重建（500ms 防抖：stop → 从 `watchers` 删除 → `reconcileWatchers`）；验证：`test/lsp-config.test.ts` 断言重建后 `gitignoredDirectories` 被再次调用

## 5. 文档同步

- [x] 5.1 更新 `openspec/specs/lsp/spec.md` 的 `## Implementation`：配置解析段补 `watch.useGitignore`，文件监听段说明 gitignore 目录级排除与 `.gitignore` 刷新、内置忽略清单
- [x] 5.2 更新 `src/skills/lsp-config/SKILL.md` 的 watch 段：补充 `useGitignore` 缺省值、只排除整体忽略目录、生成产物取舍与 `false` 恢复方式、内置忽略清单

## 6. 集成验证

- [x] 6.1 运行 `pnpm test`、`pnpm check`、`pnpm lint` 全绿
- [ ] 6.2 在含明显 gitignore 目录的仓库手动跑一次 LSP 会话，确认启动无错误且该目录内改动不产生 `didChangeWatchedFiles`（watch 日志 / 断点或现有 e2e 辅助）

## Workflow follow-up

- 归档 change 前同步 spec delta 到 `openspec/specs/lsp/`，并运行 `openspec validate lsp-watch-gitignore --strict`。
