## Context

动机见 proposal.md。实现约束：

- `watcher.ts` 的 `watchWorkspace(dir, ...)` 只订阅单个目录（`@parcel/watcher` 的 `subscribe` 签名是 `dir: string`），内核层 `ignore` 的 glob 按"相对被监听目录"匹配；事件层 `isIgnored` 同样以被监听目录为基准。
- `lsp.ts` 目前是单例 watcher 固定在 `state.cwd`：`ensureWatcher(cwd)` 在 `startClient` 里调用，`reload`/`closeAll` 停止，cwd 变化时重建；`fanOut` 按 `containsPath(path, cwd)` + `containsPath(path, client.root)` + 注册 pattern + 扩展名过滤。
- 引入 per-server root（`rootMarkers` / `workingDir`）后，watch 范围（cwd 全树）与投递范围（client root 子树）脱节：兄弟目录被监听但永远不会投递。

## Goals / Non-Goals

**Goals:**

- 监听范围等于活跃 client 的 root 集合：去重（被包含的 root 不单独监听）、裁剪（不越会话 cwd）、无活跃 client 时不监听。
- `fanOut` 投递语义完全不变。
- 监听器生命周期跟随 client 增删，增量维护而不是每次重建。

**Non-Goals:**

- 按注册 pattern 的静态前缀或文件类型裁剪目录。实测主流服务器注册的 pattern 静态前缀都等于 root（pyright `**` / `**/pyrightconfig.json`、gopls `**/*.{go,mod,sum,work}`），以 root 为单位已等价；更细裁剪需要目录扫描 + 新建目录处理，收益低。
- 监听 cwd 之外：服务器注册的 root 外 pattern 一律不处理（用户已确认）。
- 支持 `RelativePattern{baseUri, pattern}` 或改动注册 pattern 的匹配语义——那是「尊重服务器注册的监听 pattern」的独立问题。

## Decisions

### D1：以活跃 client 的 root 为单位，而不是 cwd 或注册 pattern

root 是投递过滤的既有边界（`fanOut` 已按 `client.root` 过滤），也是服务器注册 pattern 的相对基准（`workspaceFolders` = root）。按 root 建立监听，既不监听永远不投递的兄弟目录，也不受 pattern 表达能力限制。备选：单 cwd 监听（现状，容器目录浪费）；按 pattern 静态前缀监听（对主流服务器等价，额外复杂度无收益）。

### D2：增量 reconcile（`Map<root, WorkspaceWatcher>`）

维护 `root → watcher` 映射：每次 client 集合或 cwd 变化时计算 desired roots（各 client root ∩ cwd 后去掉被其他 root 包含的），只对差集 stop/start，已有 watcher 保持不动。触发点：`startClient` 注册 client 之后、`reload` / `reloadAll` 清理 client 之后、`closeAll`、`state.cwd` 变化。配置（`watch.enabled` / ignore / 去抖）继续从 `currentConfig(cwd)` 读。备选：每次变化全部重建（简单但新增一个 client 会打断已有 root 的事件流）。

### D3：root 不在 cwd 内时监听 cwd

绝对 `workingDir` 可能指向 cwd 的祖先（如 cwd `/repo/packages/a`、workingDir `/repo`）。该 client 只能服务 cwd 内的文件（`getClients` 的 `containsPath(file, cwd)` 前置），有效范围就是 cwd，因此监听 cwd 而不是它的 root。

### D4：`watch.ignore` 基准改为每个被监听 root

parcel 的 ignore glob 相对被监听目录匹配，多 root 下无法用一份 cwd 相对 pattern 表达；事件层 `isIgnored` 也跟随 watcher 的目录基准。root 即 cwd 时语义与现在完全一致，`DEFAULT_IGNORE` 与用户常用的 `**/` 前缀 pattern 不受影响。备选：保持 cwd 基准——需要给 parcel 传绝对/改写后的 pattern 且事件层另算基准，复杂度不值。

### D5：投递语义不变，保留"未注册 watcher 的 client 收 root 内全部事件"

tsserver（typescript-language-server 不注册 `workspace/didChangeWatchedFiles`）依赖这些事件保持未打开文件的跨文件新鲜度，e2e 有覆盖（"外部修正被依赖文件后…"）。本次只收窄监听范围，不改投递判定。

## Risks / Trade-offs

- [watcher 数量随 root 数增长（每个 root 一个 parcel 订阅）] → root 数 = 活跃服务器所在的项目数，且被包含的 root 已去重；远小于目录树规模。
- [新增 root 时存在启动窗口，窗口内的事件丢失] → 与现状首次启动 watcher 的窗口一致；差集 reconcile 保证已有 root 不中断。
- [`watch.ignore` 基准变化对 rootMarkers 用户是行为变化] → skill 文档写明"相对每个被监听的项目根"；`**/` 前缀 pattern 无差异。
- [cwd 变化后旧 client 的 root 不在新 cwd 内，其 watcher 被移除] → 这些 client 的投递本来就按新 cwd 过滤（`fanOut`），移除监听不改变可观测行为。

## Migration Plan

无配置变更、无数据迁移。单项目仓库（root = cwd）行为与现状完全一致；只有 root 落在子目录时才减少监听范围。回滚只需恢复单例 cwd watcher。
