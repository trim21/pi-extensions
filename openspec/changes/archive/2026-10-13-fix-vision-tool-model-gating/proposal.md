# Proposal

## Why

`describe_image` 现在无条件进入模型可见的工具清单：只要配置了 `visionConfig.model`，无论主模型是否支持视觉都会注册。原因是 `266cf17`（收敛工具注册到单一入口）之后，按模型隐藏工具的逻辑只留在 `src/vision-agent.ts` 的默认导出（`syncVisionMode`，用 `pi.setActiveTools`），而 `pi.extensions` 已不再加载该默认导出 —— 入口走的是 `createVisionTools()`，它只看 `visionConfig`，不看模型。结果是 `openspec/specs/vision-agent/spec.md` 的「主模型有视觉时不注册」在真实运行里失效，多模态主模型的会话白背一个永不使用的工具描述。

## What Changes

- `describe_image` 的可见性改为在 `session_start` 按本会话 `ctx.model` 判定：模型支持视觉就**不注册**（图片由 pi 原生透传），不支持才注册。
- 删除 vision-agent 里 `pi.getActiveTools` / `pi.setActiveTools` 的用法与 `model_select` 同步逻辑：工具可见性只由「注册与否」决定，符合 `tool-registration` 的既有要求（扩展 MUST NOT 通过调整 active 列表改变可用性）。
- 未配置 `visionConfig`（或没有 `model`）时行为不变：不注册工具。
- 默认导出（按路径独立加载的形态）与入口注册走同一套判定，行为一致。
- 顺带删掉 `model_select` 上「会话中途切模型改工具面」的同步逻辑与对应通知：预期不会在会话过程中切换模型，判定只在会话启动时做一次。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `vision-agent`：把「工具按视觉能力注册」的要求写实到判定时机与机制（`session_start` 按 `ctx.model` 决定注册与否，不调整 pi 的 active 列表），并补上「同一会话内切换模型不改工具面」这一与 `tool-registration` 对齐的行为。

## Impact

- 代码：`src/vision-agent.ts`（`createVisionTools` 接收本会话上下文并按模型决定是否注册；默认导出改为同一套 `session_start` 注册路径）、`src/index.ts`（工具模块的 `register` 拿到 `session_start` 的 `ctx`）。
- 测试：`test/vision-agent.test.ts`（把「多模态隐藏 / text-only 显示」改成断言注册与否）、`test/tool-registration-entry.test.ts`（入口层覆盖 describe_image 的按模型注册；当前该文件把 vision 模块整体 mock 掉，正是这个回归没被测到的原因）。
- 行为：支持视觉的主模型下 `describe_image` 从工具清单消失（回到 spec 声明的行为）；同一会话内 `/model` 切换不再改变工具面。
- 不涉及：`visionConfig` / `sessionName` 配置格式、图片加载与视觉模型调用（`callVision` / `completeText`）、`prompt` 语义、其它模块与工具集。
