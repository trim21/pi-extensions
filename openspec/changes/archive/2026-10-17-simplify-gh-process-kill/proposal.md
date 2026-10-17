# Proposal

## Why

`runGh` 为 gh 子进程维护了「SIGTERM → 5 秒后 SIGKILL」的升级逻辑，但 `gh` 现在只剩 `repo view` 与 `auth token` 两个短命令，不响应 SIGTERM 的卡死场景几乎不存在；这套逻辑带来的定时器、退出判断与清理反而让实现变复杂。去掉升级，只发 SIGTERM，等父进程退出时由内核回收。

## What Changes

- `runGh` 在超时 / 中止时只发送 SIGTERM，不再排 SIGKILL 定时器；结果仍记录 `killed` 与原因。
- 同步删掉 `sigkillId` 的清理与对应测试，spec 中「5 秒后 SIGKILL」的描述改为只发送 SIGTERM。
- 其余行为不变：被杀的进程仍记为失败，`code` 仍为 `-1`，stdout / stderr 仍完整返回。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无，spec 已同步为当前行为）

## Impact

- 代码：`src/lib/gh-process.ts`。
- 测试：`test/run-gh-timeout.test.ts`。
- 规范：`openspec/specs/gh-readonly/spec.md`（直接同步）。
