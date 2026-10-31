# Proposal

## Why

子代理进度面板固定行（banner）里有两段信息价值偏低：费用保留 4 位小数（`$0.0123`），精度远超 provider 累计值的区分度，末位波动只会在面板上跳动；turn 计数只是 assistant 消息条数，日志行已经展示实际发生的工具与文本，重复且占宽。

## What Changes

- 固定行的费用改为固定 3 位小数（四舍五入），如 `$0.0123` → `$0.012`、`$0.5` → `$0.500`。
- 固定行不再显示 turn 计数；`usage.turns` 及其计数逻辑一并删除（display-only 字段，删除后无消费者）。
- 费用为 0 时该段仍然省略，其余 usage 段（ctx / 模型名）与面板布局不变。
- 不改变 `usage.cost` / `contextTokens` 的采集与返回给父 agent 的数据。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `spawn-agent`：`进度可见` 要求补充固定行的费用显示精度（固定 3 位小数），并去掉 turn 计数。

## Impact

- 代码：`src/spawn-agent-progress.ts`（`formatUsageStats`、`ProgressUsage`）、`src/spawn-agent.ts`（`UsageStats`、`message_end` 计数）。
- 测试：`test/spawn-agent-progress.test.ts`、`test/spawn-agent.test.ts` 的 footer 断言与 usage fixture。
- 兼容性：只影响进度面板文案与内部结果字段，不影响工具输出、`details` 数据或任何接口。
