# Design

## Context

现有 `watchWorkspace` 在 `@parcel/watcher` 订阅失败或运行期报错时统一走 `onError`，`lsp.ts` 对 ENOSPC / EMFILE 直接停用该 root 直到 `/lsp-reload`。参见 proposal.md 的动机。

关键事实：

- `InotifyBackend` 继承 `BruteForceBackend`，后者实现 `writeSnapshot` / `getEventsSince`：遍历目录树写快照、与快照对比产生 create / update / delete 事件。
- `getEventsSince` 的遍历走 `iterateDir`，其中调用 `watcher->isIgnored`，因此内置忽略、`watch.ignore` 与 gitignore 目录在轮询模式下同样生效。
- 快照对比是全树 stat，成本随目录规模增长；只应作为资源耗尽后的降级路径。

## Goals / Non-Goals

**Goals:**

- ENOSPC / EMFILE 时继续投递工作区文件事件，而不是停用监听。
- 轮询间隔可配置，关闭开关可恢复旧的停用行为。
- 快照文件生命周期由监听器管理，不残留。

**Non-Goals:**

- 不改变正常路径（inotify 订阅可用时仍用事件源）。
- 不尝试在轮询模式下增量优化（例如只扫描 git 变更）；本轮复用 parcel 的 brute-force 快照。
- 不自动探测 inotify 上限或修改系统参数。

## Decisions

### 复用 parcel 的快照 API

用 `writeSnapshot(dir, snapshot, { ignore })` 建立基线，之后每轮 `getEventsSince` 拿变化再重写快照。替代方案是自己 `readdir` 遍历并维护 mtime 表：需要自己实现 ignore 应用与事件类型判定，且与现有 parcel 语义重复。

### 触发条件与提示

`watchWorkspace` 捕获订阅启动失败与运行期错误，用与 `lsp.ts` 相同的正则（`ENOSPC|EMFILE|No space left on device`）判定资源耗尽：

- 命中且 `pollingFallback` 开启：进入轮询，调用 `onDegraded(message)` 一次性提示；不触发 `onError`，因此 `lsp.ts` 不会把 root 加入 `watcherFailed`。
- 未命中或开关关闭：维持现有 `onError` 路径。
- 轮询本身失败（快照读写错误）：停止轮询并调用 `onError`，回落到停用与提示。

### 快照位置与生命周期

`join(tmpdir(), "pi-lsp-watch", "<sha1(dir)>-<pid>.snapshot")`，目录按需创建；pid 区分同一目录上的多个 pi 进程，覆盖写即可。首次 `writeSnapshot` 失败视为轮询不可用，直接走 `onError`。`stop()` 清定时器并 `rm(snapshotFile, { force: true })`。

### 事件处理防重入

现有 `handleEvents` 内部以 `void (async …)` 处理批次，轮询下两次 `getEventsSince` 可能重叠。把逐事件处理抽成返回 Promise 的函数，轮询用 `polling` 标志跳过仍在进行的上一轮；订阅路径仍不等待。

### 配置

`watch.pollingFallback`（布尔，缺省 `true`）与 `watch.pollingIntervalMs`（`timeoutValue`，缺省 5000，换算为 ms）。两者进入 `EffectiveWatchConfig` 并透传给 `watchWorkspace`；`mergeWatch` 的逐字段覆盖天然支持本地关闭。轮询间隔下限沿用 `timeoutValue` 数字 `>= 1` 的约束。

### 降级提示

`lsp.ts` 的 `onDegraded` 用独立的 `notified` 集合节流，提示文案包含原因、间隔与恢复建议（提高 `fs.inotify.max_user_watches` 后 `/lsp-reload`）。

## Risks / Trade-offs

- [轮询每轮全树 stat，大仓库 CPU / IO 开销明显] → 只在资源耗尽时启用；间隔可配（缺省 5s）；提示里写明成本；`pollingFallback: false` 可回到停用。
- [事件延迟最多一个轮询间隔] → 文档写明；诊断链路本身有等待窗口，影响可控。
- [快照文件残留（进程崩溃）] → 文件名含 pid，下次覆盖写；系统临时目录负责最终清理。
- [`.gitignore` 变更后重建 watcher 仍可能再次 ENOSPC] → 重建后重新尝试订阅，失败则再次进入轮询，语义一致。
