# Tasks

## 1. 共享格式化

- [x] 1.1 在 `src/lib/bash-tool.ts` 增加 `systemReminder(text)`，输出 `<system-reminder>\n...\n</system-reminder>`，并验证两套工具都能从该模块导入

## 2. claude-code Bash

- [x] 2.1 用户取消分支用 `systemReminder` 包裹 `Command aborted by user ...`，运行 `pnpm test test/claude-code-tools.test.ts` 验证取消文本断言通过
- [x] 2.2 超时分支用 `systemReminder` 包裹 `Command timed out after ...`，运行 `pnpm test test/claude-code-tools.test.ts` 验证超时文本与沙箱提示断言通过

## 3. opencode bash

- [x] 3.1 超时与取消分支用 `systemReminder` 包裹对应状态行，更新 `test/opencode-bash.test.ts` 断言并运行 `pnpm test test/opencode-bash.test.ts`

## 4. 整体验证

- [x] 4.1 运行 `pnpm test`、`pnpm check`、`pnpm lint`，确认全部通过且 diff 只包含本次相关改动

## Workflow follow-up

- 完成实现后归档本次 change。
