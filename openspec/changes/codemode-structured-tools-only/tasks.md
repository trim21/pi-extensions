# 任务

## 1. 准入条件

- [x] 1.1 `src/codemode/tool.ts`：删掉 `EXCLUDED_TOOL_NAMES`，`collectTools` 改成「声明了 `structuredSchema`」+ active 求交，更新头部注释
- [x] 1.2 `CallableTool.structuredSchema` / `declarations.ts` 的 `ToolLike.structuredSchema` 改为必需，`renderOverload` 删掉 `Promise<string>` 分支
- [x] 1.3 README 与 AGENTS.md 的说明改为「有结构化输出才可调用」，去掉黑名单描述

## 2. 测试

- [x] 2.1 `test/codemode-tool.test.ts`：桩工具（`echo`）改为声明 schema 并返回 `structuredResult`，新增「只声明 schema 但只给文本」的桩
- [x] 2.2 描述断言改成「有 schema 的在、没 schema 的不在（含 `codemode` 自身 / `spawn-agent` / 文件工具）」
- [x] 2.3 断言「声明了 schema 却没给载荷」时脚本拿到 `CallFailedError`（覆盖总线运行期复核 + `onCall` 回退分支）
- [x] 2.4 原有的「文件工具不可调用」「未 active 工具不可调用」用例保持通过

## 3. 文档与验证

- [x] 3.1 openspec delta：改「工具注册与可调用工具集合」，去掉黑名单措辞、加「有结构化输出才进」与相应场景
- [x] 3.2 `pnpm check`、`pnpm lint`、`pnpm test`
- [x] 3.3 归档顺序：先归档 `bash-structured-results`（已随 #176 合并，本 delta 整段替换它改过的 requirement），再本条
