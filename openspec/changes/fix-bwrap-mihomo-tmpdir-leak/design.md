# Design

## Context

动机见 `proposal.md` - Why。影响方案的现状：

- `mihomoHome = <agentDir>/tmp/mihomo-<uuid>` 在 `startNetworkStack` 开头 `mkdir`，作为 `-d` 参数传给 holder（holder 再传给 mihomo）；`stop` / `catch` / `stackFinalizer` 三处清理路径都只杀进程。
- 停栈流程刻意不等 pid ns 完全清空（SIGKILL `unshare` 后 `waitForExit` 约 50ms 返回，init 与 mihomo 还要 ~50ms 才退出），删除目录时过滤进程可能仍持有目录内的 cache.db。
- 目录内容只有 mihomo 的运行时缓存（实测一个 16KB 的 cache.db），mihomo 每次启动都新建，不存在需要跨命令保留的状态。
- 启动失败路径已经在落盘诊断材料：`writeFailureLog` 把 holder / slirp 输出与错误本身写到 `<agentDir>/tmp/bwrap-netstack-<uuid>.log`，并把路径附进抛出的错误信息。

## Goals / Non-Goals

**Goals:**

- 正常停栈与 GC 兜底两条路径都不留临时目录（这是泄漏的唯一来源：每条命令都走 `stop()`）。
- 删除失败绝不改变命令结果或抛出到调用方。

**Non-Goals:**

- 不做启动时清扫历史目录：宿主被 SIGKILL 或整机重启时无退出路径可执行，根治需要判据（mtime 阈值 / 记录持有者 pid），取舍另议。
- 不改目录命名、`-d` 传参或「每次启动独立目录」的既有设计（并发实例的 bbolt 锁隔离靠它）。
- 不在启动失败路径清理目录——见 D4。

## Decisions

**D1：删除放在停栈流程末尾，与进程清理同一级别，用 `rm(dir, { recursive: true, force: true })`。**

`force` 让「目录已不存在」不报错，`recursive` 覆盖 cache.db 等内部文件。不额外等待过滤进程退出：Linux 上删除仍被打开的文件只是 unlink，写者继续写到已 unlink 的 inode，进程退出后空间自动回收；为目录删除引入等待会把刚修好的毫秒级停栈重新拖慢。

**D2：删除失败静默吞掉，只记录不抛。**

与既有 `stop()` 里「停栈失败不掩盖命令结果」的约定一致（`runInSandbox` 的 `finally` 已经 best-effort 处理 `stack.stop()` 抛错）。目录残留是资源问题，不该让一条已经成功的命令变成失败。

**D3：`stackFinalizer` 里用 fire-and-forget 的删除。**

FinalizationRegistry 回调不能 await。这里 `void rm(...).catch(() => undefined)`，语义上只是 GC 兜底路径的尽力而为。

**D4：启动失败路径刻意不删目录。**

那个分支本身就在收集现场材料（holder / slirp 输出落盘成 `bwrap-netstack-*.log` 并附进错误信息），同一个 catch 里删掉同一次启动的工作目录是自相矛盾的：要么都不留，要么都留。既然诊断日志要留，工作目录一并留。代价是失败时确实多一个目录残留——失败路径罕见（每次失败的启动一个，不是每条命令一个），换来的是排查时现场完整。

考虑过的替代方案：

- _失败路径也删_：与「保留现场」冲突，且删掉的 cache.db 换不来任何收益——它不记录错误，失败原因都在 holder 输出里；唯一的收益是「任何路径都不留残骸」这条更整齐的规则。
- _失败路径只删 cache.db、保留目录_：得到的是一个空目录，既没有诊断价值也没有清理收益，比两个极端都差。

**D5：清理路径各自删除，不抽公共函数。**

两处的上下文本来就在同一个 `startNetworkStack` 作用域内、共享 `mihomoHome`，一行 `rm` 调用比引入一个只包一行的 helper 更直白。

## Risks / Trade-offs

- [过滤进程仍在写 cache.db 时目录被删] → 已打开的 fd 继续有效，只是该 inode 不再有目录项；不影响进程退出，也不会让删除报错。
- [并发栈互相删错目录] → 每个实例的目录名带独立 uuid，只删自己创建的那个。
- [GC 兜底删除失败（进程退出中、权限变化）] → 属于 best-effort 路径，与它同时处理的进程残留一样不保证成功。
- [启动失败后目录永久残留] → D4 的有意取舍；这类目录与诊断日志成对出现，清理时机由用户决定。
- [宿主 SIGKILL 后仍残留目录] → 已在非目标里明确；本变更只保证有退出路径可执行的时候不留残骸。

## Migration Plan

无需迁移。代码随重启 pi agent 生效；回滚即去掉两处 `rm`。
