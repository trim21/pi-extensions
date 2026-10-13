# Tasks

## 1. 入口把本会话上下文交给工具模块

- [x] 1.1 `src/index.ts`：`ToolModule.register` 增加第二个参数 `ctx`（`ExtensionContext`），并在 `session_start` 遍历模块时传入；其余模块的 `register(bus)` 保持不变。验证：`pnpm check`（`tsc --noEmit` 通过，说明现有模块仍类型兼容）
- [x] 1.2 `src/vision-agent.ts`：`createVisionTools()` 返回的模块改为 `register(bus, ctx)`，`isMultimodal(ctx.model)` 为真时不注册（`visionConfig` 缺失仍返回 `undefined`）；默认导出删除 `model_select` / `getActiveTools` / `setActiveTools`，改用 `registerToolsOnSessionStart` 走同一套判定。验证：`pnpm check` + `pnpm lint`

## 2. 测试

- [x] 2.1 `test/vision-agent.test.ts` 的 `tool registration` 组改为断言注册与否：text-only 模型注册、多模态模型不注册、未配置 `visionConfig` 不注册（含默认导出路径与 `register(bus, ctx)` 路径）；删除对 `getActiveTools` / `setActiveTools` 的 fake。验证：`pnpm vitest run test/vision-agent.test.ts`
- [x] 2.2 `test/tool-registration-entry.test.ts`：vision 的 mock 改为接受 `(bus, ctx)` 并按模型返回（或直接使用真实模块），新增断言——多模态模型的会话里最终工具清单没有 `describe_image`，text-only 模型里有。验证：`pnpm vitest run test/tool-registration-entry.test.ts`

## 3. 文案

- [x] 3.1 `README.md` 的 vision-agent 小节（`README.md:561-592`）说明判定时机：按**会话启动时**的主模型决定是否注册 `describe_image`，不在会话过程中重新判定。验证：`grep -n "describe_image" README.md` 复核措辞，`pnpm check` 通过

## 4. 集成验证

- [x] 4.1 全量检查：`pnpm test`、`pnpm check`、`pnpm lint` 全绿
- [x] 4.2 手工验证：在支持视觉的主模型下 `/new` 开新会话，确认工具清单里没有 `describe_image`；切到不支持视觉的主模型开新会话，确认它在。验证：会话工具清单的实际观察结果（需要重启 pi 生效）

## Workflow follow-up

- 实现与验证完成后，用 `openspec-archive-change` 归档本变更（把 `vision-agent` 的 delta 合入 `openspec/specs/vision-agent/spec.md`）。
