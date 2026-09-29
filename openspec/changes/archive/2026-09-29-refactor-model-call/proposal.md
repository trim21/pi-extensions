# Proposal

## Why

「经 pi 的模型注册表发起一次文本生成调用」没有归属地。仓库里有两个扩展各自实现一遍（`src/vision-agent.ts` 的 `callVision`、`src/session-name.ts` 的 `callNamer`），重复的不只是几行调用，而是**同一组不变量**：

- `ModelRegistryLike` 接口（registry 的鸭子类型，`find` + `complete` 两个方法）逐字重复两份（`vision-agent.ts:106-113`、`session-name.ts:82-89`）；
- `withTimeout(signal, ms)` 逐字重复两份（`vision-agent.ts:273-277`、`session-name.ts:219-223`），两份的注释也一样：「调用方未传时仍然有超时兜底」——这是 `ctx.signal` 在 agent 空闲时为 undefined 时的必需品；
- 「`registry.complete(...)` → `contentText(result.content).trim()` → 空则 `throw new Error("API 未返回内容")`」重复两份，连错误文案都相同；
- `maxTokens` 与超时的组合方式（`{ maxTokens, signal: withTimeout(signal, timeoutMs) }`）重复两份。

先例是 `refactor-egress-module`（2026-09-28）：那次的原话是「没有任何一处是『出网』这件事的归属地……不是疏忽的个例，是缺少一处归属的结果」，之后所有出网调用都经 `src/lib/egress.ts`。这次同样不是顺手去重：pi 的 registry 契约一变，或者「空正文算不算失败」这条判断要改，就得在两处同步。

## What Changes

- 新增 `src/lib/model-call.ts`：`completeText({ registry, model, systemPrompt, content, maxTokens?, timeoutMs, signal? })` 返回 `{ text, usage }`。它持有这四件事：provider 注册表契约（`ModelRegistryLike` 的唯一定义）、消息封装（user 消息 + `timestamp`）、超时兜底（与调用方 signal 合并）、正文提取与空正文判定。
- `src/vision-agent.ts`：删除本地的 `ModelRegistryLike` 与 `withTimeout`，`callVision` 的注册表调用改为 `completeText`；`VisionAbortError` 的映射（`AbortError` → 取消）保留在 `callVision`，因为那是它自己的语义。
- `src/session-name.ts`：同上，`callNamer` 改用 `completeText`。
- 新增 `test/model-call.test.ts`：把模块自己的契约钉住（maxTokens 缺省取 `model.maxTokens`、超时与调用方 signal 的合并、thinking 块不算正文、空正文报错、`usage` 透传、registry 错误原样抛出）。
- 两个扩展的既有测试改从 `src/lib/model-call.js` 导入 `ModelRegistryLike`，其余断言（含 `callVision` / `callNamer` 层对 `maxTokens`、`signal`、prompt 的端到端断言）**原样保留**，作为「行为不变」的证据。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无。`openspec/specs/session-name/spec.md:54` 只写到「通过 pi 的模型注册表与 AI SDK 调用命名模型，不手写 HTTP」这一层，本次改动之后这句话依然成立；`vision-agent` 的 spec 描述的是工具行为与配置，不涉及调用实现。因此 `.openspec.yaml` 标记 `skip_specs: true`。）

## Impact

- 代码：新增 `src/lib/model-call.ts`；`src/vision-agent.ts`（删 `ModelRegistryLike`、`withTimeout`，`callVision` 收窄）；`src/session-name.ts`（同上，`callNamer` 收窄）。
- 测试：新增 `test/model-call.test.ts`；`test/vision-agent.test.ts`、`test/session-name.test.ts` 只改一行 import。
- 不涉及：配置格式（`settings.json` 的 `visionConfig` / `sessionName` 解析）、`ctx.modelRegistry` 的取用方式、`AbortError` 的既有语义（vision 转 `VisionAbortError`、session-name 静默回退）、`spawn-agent-agents.ts` 的 settings 兜底（那是「读配置」不是「发调用」，另议）、依赖与公开 API。
