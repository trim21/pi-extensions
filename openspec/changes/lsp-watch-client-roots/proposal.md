# LSP 文件监听范围跟随活跃服务器的项目根

## Why

工作区文件监听器固定建在会话 cwd 上（`watchWorkspace(cwd)`），与语言服务器实际的 root 无关。只要有一个 client 启动，就会对整棵 cwd 目录树创建 inotify watch——即使活跃 client 的 root 只是其中一个子目录。

两个场景因此浪费明显：容器 cwd（如 `~/projects` 下并列多个仓库）里只有一个项目的服务器在跑，却监听所有仓库；per-server `rootMarkers` / `workingDir` 把 root 定在子目录时，兄弟目录的事件根本不会投递（`fanOut` 按 `client.root` 过滤），却仍被 watch。大型仓库叠加时就是 inotify 配额的无谓消耗。

## What Changes

- 监听范围改为**当前活跃 client 的 root 集合**：每个 root 一个递归监听器；被其他 root 包含的 root 不重复监听（只留最外层）；root 不在会话 cwd 内时退化为监听 cwd（client 只服务 cwd 内的文件）。
- 监听器生命周期跟随 client 集合：client 启动时增量新增、client 关闭（reload / stop / 会话结束）时移除，cwd 变化时重算；无活跃 client 时不监听（与现状一致）。
- `fanOut` 的投递语义不变：仍按 cwd、`client.root`、服务器注册的 pattern 与扩展名过滤；没有注册 watcher 的服务器仍在自己的 root 内收到全部事件（tsserver 等依赖这一行为保持新鲜度）。
- `watch.ignore` 的匹配基准从"会话 cwd"变为"每个被监听的 root"（root 即 cwd 时语义不变）；`DEFAULT_IGNORE` 是 `**/` 前缀，不受影响。
- 同步更新 lsp spec 与 `lsp-config` skill 文档。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `lsp`: 「工作区文件事件同步」Requirement——监听器从"会话工作区目录上的单个递归监听器"改为"按活跃服务器项目根维护、去重、不越 cwd"；「生命周期跟随服务器」Scenario 相应改为跟随 client 集合的增删。

## Impact

- `src/lib/lsp/lsp.ts`：`watcher` / `watcherCwd` 单例改为 `Map<root, WorkspaceWatcher>` + 增量 reconcile；`startClient`、`reload`、`reloadAll`、`closeAll` 的挂载点调整。
- `src/lib/lsp/watcher.ts`：不改（保持单目录订阅；`@parcel/watcher` 的 `subscribe` 只接受单个目录）。
- 测试：`test/lsp-config.test.ts` 的 watcher 用例（首个 client 启动 / cwd 变化重建 / fan-out 过滤）扩展为多 root 场景，新增"子 root 被父 root 覆盖不重复监听""client 关闭后对应 watcher 停止"。
- 文档：`openspec/specs/lsp/spec.md`、`src/skills/lsp-config/SKILL.md`。
