# Proposal

## Why

`@earendil-works/pi-coding-agent` 从 1.2.0 起把 `before_agent_start` 事件拆成判别联合（`BeforeAgentStartUserEvent` 有 `prompt`，`BeforeAgentStartCustomEvent` 没有）。我们的 devDependencies 一直锁在 1.1.0，所以仓库自身 CI 看不到这个问题；但 lockfile maintenance 一重新解析就会抬到 1.2.0+，`src/session-name.ts` 的 `event.prompt` 立刻编译失败（实测锁文件维护 PR 自 2026-10-13 起一直红）。需要把依赖下限抬到 1.4.0 并适配新的事件类型，同时给这三个包定好升级策略，避免再次静默漂移。

## What Changes

- **依赖声明**：三个 `@earendil-works/pi-*` 的 `peerDependencies` 改为 `^1.4.0`（声明兼容范围），`devDependencies` 改为精确 `1.4.0`（CI 按最低可用版本测试，而不是范围的最高点）。
- **代码适配**：`src/session-name.ts` 的 `before_agent_start` 处理只对 `messageType === "user"` 的事件命名；custom message 触发的 run 没有 user prompt，直接跳过。运行时行为与 1.1.0 时代一致（那时该事件只会由 user prompt 触发）。
- **renovate**：三个 pi 包成组（`groupSlug: earendil-works-pi`）、只更新 `devDependencies`（peer 范围由人手维护）、`separateMinorPatch` 让 minor 与 patch 分开出 PR，并打 `ci:manual-merge` 标签。
- **mergify**：自动合并规则排除 `ci:manual-merge` 标签，使上述 PR 必须人工合并。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `session-name`: 「自动命名」补充 custom message 触发的 run 不参与命名的场景，明确命名只取 user prompt。

## Impact

- 代码：`src/session-name.ts`、`test/session-name.test.ts`。
- 依赖：`package.json`（peer `^1.4.0`，dev 精确 `1.4.0`）、`pnpm-lock.yaml`。
- 仓库流程：`.github/renovate.json`、`.github/mergify.yml`。
- 兼容性：扩展的最低支持的 pi 版本从 1.1.0 抬到 1.4.0；低于该版本的 pi 不再保证可用。
