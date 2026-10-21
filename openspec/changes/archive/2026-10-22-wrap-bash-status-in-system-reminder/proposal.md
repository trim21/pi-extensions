# Proposal

## Why

Bash 工具在超时或用户取消时，把 `Command timed out after ...` / `Command aborted by user ...` 直接拼在命令输出后面，与命令自身的 stdout/stderr 混在同一段文本里。模型容易把它当成命令输出的一部分，而不是工具注入的执行状态。

## What Changes

- claude-code 风格 `Bash`：超时与用户取消的状态行包进 `<system-reminder>...</system-reminder>`，仍位于命令输出之后。
- opencode 风格 `bash`：同一处理，超时与用户取消的状态行包进 `<system-reminder>`。
- 命令输出本身、截断提示、非零退出状态、沙箱状态提示与 `structuredResult` 载荷保持不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `claude-code-tools`：`Bash` 超时与中止的文本输出改为 `<system-reminder>` 包裹的状态行。
- `opencode-tools`：`bash` 超时与中止的文本输出改为 `<system-reminder>` 包裹的状态行。

## Impact

- 代码：`src/claude-code/shell.ts`、`src/opencode/bash.ts`，以及两套工具共用的 `src/lib/bash-tool.ts`（新增状态块格式化辅助）。
- 测试：`test/claude-code-tools.test.ts`、`test/opencode-bash.test.ts` 中相关断言。
- 模型可见文本变化，`details` / `structuredResult` 不变。
