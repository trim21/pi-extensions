# Proposal

## Why

`network: limited` 模式每条命令都会在 `<agentDir>/tmp/` 下建一个 `mihomo-<uuid>/` 工作目录（mihomo 的 cache.db 落在这里，每次启动用独立目录避免并发的 bbolt 文件锁争抢），但**从来不删除**：`startNetworkStack` 只 `mkdir`，`stop()`、启动失败清理、GC 兜底都没有对应的 `rm`。实测本机已累积 **10026 个目录、196MB**，且随每条沙盒命令线性增长。`sandbox.ts` 里「停栈失败（进程已退出/目录删除失败）」的注释说明删除本应是停栈的一部分，只是从未实现。

## What Changes

- `stop()` 在终止进程后删除本次的 `mihomo-<uuid>/` 目录（`rm -r`，best-effort：删除失败不影响停栈结果，与残留进程清理同级别）。
- `stackFinalizer` 的 GC 兜底把目录一并删掉（调用方忘记 `stop()` 时不至于泄漏到磁盘）。
- 启动失败路径**刻意不删**：那个分支已经在落盘诊断材料（holder / slirp 输出 + 错误的 `bwrap-netstack-*.log`），同一次启动的工作目录属于同一批现场材料，保留以便排查；失败路径罕见（每次失败的启动一个，不是每条命令一个）。
- 新增 `openspec/specs/bwrap-network/spec.md` 行为要求：正常停栈时回收临时工作目录，启动失败时保留现场。
- 清理本机已累积的 10026 个历史目录（一次性操作，不属于代码改动）。

**非目标**：不做「启动时清扫历史残留目录」的兜底。宿主被 SIGKILL 或整机重启时目录仍会残留（那时没有任何退出路径可执行），要根治需要在启动时按某种判据清扫陈旧目录——判据（mtime 阈值 / 记录持有者 pid）本身有取舍，留待单独决策。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap-network`: 新增「临时工作目录不残留」要求——网络栈停止（含启动失败）后，本次启动创建的临时工作目录 MUST 被删除。

## Impact

- 代码：`src/bwrap/network-stack.ts`（`mihomoHome` 的创建与三处清理路径）。
- 规范：`openspec/specs/bwrap-network/spec.md` 新增一条 Requirement。
- 测试：`test/bwrap-netstack-integration.test.ts` 加「停止后临时目录被删除」的断言（`RUN_NETSTACK_INTEGRATION=1` 手动运行）。
- 不涉及配置格式、公共 API、依赖或进程模型变更；停栈耗时不受影响（删除是普通文件系统操作）。
