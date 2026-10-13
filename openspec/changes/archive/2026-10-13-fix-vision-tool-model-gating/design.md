# Design

## Context

- 入口 `src/index.ts` 在 `session_start` 里遍历 `ToolModule` 并调用 `register(bus)`：**只传总线**，工具模块因此拿不到本会话模型；而按模型判定所需的 `ctx` 只在这个 handler 里有。
- `createVisionTools()` 目前只看 `visionConfig.model`，与模型无关；按模型隐藏的旧实现（`syncVisionMode`，用 `pi.getActiveTools` / `pi.setActiveTools` + `model_select`）留在**不会被加载**的默认导出上。
- 约束来自两份 spec：`tool-registration` 要求「工具可用性由注册与否决定，扩展 MUST NOT 调整 pi 的 active 列表」；`vision-agent` 要求 `describe_image` 按主模型视觉能力注册（见 proposal.md）。

## Goals / Non-Goals

**Goals:**

- `describe_image` 在入口注册路径与默认导出（按路径独立加载）路径下，都由本会话模型的视觉能力决定注册与否。
- 删掉本仓库唯一一处「扩展调整 pi active 列表」的用法，让 vision 与 `tool-registration` 的既有要求一致。
- 用测试锁住入口层行为，补上「入口测试把 vision 模块整体 mock 掉」造成的盲区。

**Non-Goals:**

- 不改 `visionConfig` / `sessionName` 配置格式与解析，不改 `callVision` / `completeText` / 图片加载。
- 不为其它工具引入通用的「按模型决定注册」机制（本次只需要把 `ctx` 交到模块手上）。
- 不处理会话中途切换模型：预期不会在会话过程中切模型，判定只在会话启动时做一次。

## Decisions

**1. 入口把 `session_start` 的 `ctx` 传给工具模块：`ToolModule.register(bus, ctx)`。**

判定必须发生在注册那一刻，而模型只有入口的 `session_start` handler 能拿到，所以把 `ctx` 沿已有的调用点传下去，注册求值点仍然是唯一一处。

- 备选：让 vision 模块自己 `pi.on("session_start")` 注册 —— 注册时机被拆到两处，模块契约出现两种入口，入口的 `diagnostics()` / `unmatchedPatterns()` 汇总还得依赖 pi 的 handler 调用顺序；否决。
- 备选：加一条 `personalExtensions.disabledTools` 的按模型规则 —— 那是用户配置，不能替代 spec 对扩展行为的要求；否决（作为用户侧临时 workaround 仍可用）。
- 备选：把 vision 做成 `ToolUnit` 表的一项 —— 那张表是「文件 IO 工具集 + 子代理按声明挑单元」用的，`describe_image` 不进子代理，套上去是多余的抽象；否决。
- 其它模块的 `register(bus)` 少一个参数仍然类型兼容（TS 允许忽略额外实参），因此只有 vision 需要改动。

**2. 判定表达式沿用 `isMultimodal(ctx.model)`。**

只看 `model.input` 是否含 `"image"`，不引入模型 id 白名单 —— id 列表会随模型版本腐坏，而 `input` 是模型元数据里的真实能力声明（`ctx.model` 为 `Model<any> | undefined`，与现有鸭子类型签名兼容）。

**3. 默认导出 `visionAgent` 走同一套 `session_start` 注册，删除 `model_select` / `getActiveTools` / `setActiveTools`。**

用 `registerToolsOnSessionStart(pi, (bus, ctx) => tools.register(bus, ctx))`，让两条路径共用同一段逻辑，满足 `tool-registration` 的「模块按路径独立加载时行为与入口一致」；同时消掉扩展对 active 列表的操作。

**4. 未配置 `visionConfig` 时 `createVisionTools()` 返回 `undefined`（不变）。**

配置缺失在注册期就短路，不必等到拿到模型。

## Risks / Trade-offs

- [支持视觉的会话里 `describe_image` 彻底消失，无法再手动走视觉代理] → 这是 spec 的既定取舍（图片由 pi 原生透传）；若以后确实需要「多模态模型下也显式调用」，另开变更加配置开关，本次不做。
- [`syncVisionMode` 的两条通知（「已隐藏 / 已启用」）随之消失] → 预期不会在会话中途切模型，判定只在会话启动时做一次，因此不再需要这两条提示；实现时同步修正文案里对即时切换的暗示。
- [入口给模块多传一个参数可能影响其它模块] → 参数可选、TS 类型兼容；用 `pnpm check` 与入口测试验证。
- [回归测试盲区再次出现] → 入口测试不再只依赖 `createVisionTools` 的 mock：让它接受 `(bus, ctx)` 并按模型返回，或用真实模块断言多模态模型下 `describe_image` 未注册。

## Migration Plan

单次提交内完成：`src/index.ts` 的模块契约、`src/vision-agent.ts` 的注册路径、两个测试文件、`vision-agent` 的 spec 归档。无配置迁移、无数据迁移。回滚 = 恢复这几个文件。

## Open Questions

- 是否需要为「多模态模型下仍想显式调用视觉代理」提供配置开关？本次实现不受影响，有需求再另开变更。
