# Proposal

## Why

文件 IO 工具集在 Read/Edit/Write 之上叠加了一层 read-before-write 记账：读取时记录内容快照、Edit/Write 要求目标文件「已读且读后未变」、工具结果里带上 `details.reads` 以便跨会话重放。这层防呆对交互式使用有价值，但当模型或上层流程自己保证读序时（例如由外部编排、由另一个工具集负责读写），它只会带来额外的失败路径：先读、读后被外部改动即拒绝写入，且无法关闭。

`personalExtensions.fileIo` 的职责是选择哪一套 toolset（claude-code / opencode），不适合承载「关掉 toolset 上某一层行为」的语义。因此新增一个独立开关，只控制这层记账，不动 toolset 的选择。

## What Changes

- `personalExtensions` 新增布尔配置 `fileIoReadTracking`（默认 `true`）。
- `fileIoReadTracking: false` 时，生效的**文件 IO 工具集**（claude-code 与 opencode 两套，含子代理经 `subagentToolsExtension` 加载的那一份）：
  - Read/read 不再写已读记账，工具结果的 `details.reads` 不再出现；
  - Edit/Write（edit/write）不再要求「已读且读后未变」，不再做 stale 校验；
  - LSP rename 落盘的文件不再标记为已读；
  - 会话启动 / 树内跳转时的已读记账回放变为空操作。
- codemode 的脚本文件原语（`fs.read` / `fs.write`）自身的记账与 stale 校验不在本开关范围内，行为不变；`fileIoReadTracking: false` 只让它们的记账不再跨会话回放（因为它们的结果仍写 `details.reads`，重放入口被关掉）。
- 非法取值（非布尔）走既有警告路径：该键被忽略、其余配置照常生效。
- 未配置时行为与今天完全一致。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `tool-registration`: `personalExtensions` 的「启用配置」新增 `fileIoReadTracking`，并补充默认值与非法取值的场景。
- `claude-code-tools`: 「文件工具」的 Edit/Write 已读要求与 Read 的记账、`details.reads` 随开关变化。
- `opencode-tools`: `read` / `edit` / `write` 的同一套要求随开关变化。

## Impact

- 配置层：`src/lib/tools-config.ts`（schema、解析、`ToolsConfig` 字段）。
- 入口接线：`src/index.ts`（主入口在建工具集时传入开关）、`src/spawn-agent.ts`（子代理同一份配置）。
- 文件工具集：`src/claude-code/files.ts`、`src/opencode/files.ts`（新增选项、记账与校验分支、`restoreReads`、LSP rename 的 `recordReads`）。
- 测试：`test/tools-config.test.ts`、`test/tool-registration-entry.test.ts`、`test/claude-code-tools.test.ts`、opencode 侧的 edit/write 测试、spawn-agent 相关测试。
- 无新依赖，无 API 破坏性变更（默认值保持现有行为）。
