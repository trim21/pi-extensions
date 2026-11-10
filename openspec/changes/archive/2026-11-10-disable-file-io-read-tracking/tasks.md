# Tasks

## 1. 配置层

- [x] 1.1 `src/lib/tools-config.ts`：把 `personalExtensions` 的解析收成整段 `toolsConfigSchema`（默认值用 schema 上的 `default` 声明，解析时 `Value.Default` 补齐后经 `parseWithSchema` 校验），非法条目仍逐字段 / 逐条目降级告警；新增 `fileIoReadTracking`（`Type.Boolean`，缺省 `true`），`ToolsConfig` 增字段，文件头示例注释补上该 key。验证：`test/tools-config.test.ts` 新增「缺省 true / 显式 false / 非布尔告警且回退 true」用例，原有 20 个解析用例保持通过。
- [x] 1.2 解析用例同步到 `openspec/specs/tool-registration/spec.md` 的落点检查：delta 里「启用配置」的 key 列表与场景与实现一致（归档时同步，不在此改主 spec）。验证：`openspec validate disable-file-io-read-tracking` 通过。

## 2. claude-code 工具集

- [x] 2.1 `src/claude-code/files.ts`：`ClaudeCodeFileToolOptions` 增加 `readTracking?: boolean`（缺省 `true`）；为 `false` 时 Read/Edit/Write 不记账（结果不带 `details.reads`）、Edit/Write 跳过 `requireCurrentRead`、LSP rename 不传 `recordReads`、`restoreReads` 直接返回；默认导出把 `createToolRegistration(pi).config.fileIoReadTracking` 传进去。验证：`test/claude-code-tools.test.ts` 新增用例——关闭后未读即可 Edit / 覆盖 Write 成功且 `details.reads` 为 undefined，缺省用例「requires a complete Read before Edit」仍通过。

## 3. opencode 工具集

- [x] 3.1 `src/opencode/files.ts`：`OpencodeFileToolOptions` 增加 `readTracking?: boolean`，关闭时 read/edit/write 不记账、不写 `details.reads`、跳过 `requireCurrentRead` / `requireUnchangedRead`、LSP rename 不传 `recordReads`、`restoreReads` 直接返回；默认导出同样读配置。验证：`test/opencode-edit.test.ts` 新增「关闭后未读即可 edit、覆盖 write 成功、`details.reads` 不存在」的用例，既有 21 个用例保持通过。

## 4. 入口接线

- [x] 4.1 `src/index.ts` 与 `src/spawn-agent.ts`（`subagentToolsExtension`）：创建两套文件工具集时把 `registration.config.fileIoReadTracking` 作为 `readTracking` 传入，主入口与子代理行为一致。验证：`test/tool-registration-entry.test.ts` 新增用例——同一文件在缺省配置下 Read 带 `details.reads`、`fileIoReadTracking: false` 下不带；`test/spawn-agent.test.ts` 新增用例确认子代理的 Read 同样不记账。
- [x] 4.2 确认 `codemode` 注入的 `reads` 不受影响：关闭记账后脚本 `fs.read` + `fs.write` 仍工作，未 `fs.read` 的 `fs.write` 仍被拒绝。验证：`test/codemode-fs.test.ts` 现有用例保持通过。

## 5. 集成检查

- [x] 5.1 跑 `pnpm check`、`pnpm lint`、`pnpm test`，三项全绿（`pnpm test`：102 passed / 1 skipped 文件，1529 passed / 10 skipped 用例）；`git diff` 只含本变更涉及的文件。
