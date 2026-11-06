# Design

## Context

`request-headers` 目前是 package.json `pi.extensions` 里的独立入口，主会话会加载它，从而在主会话的 `ExtensionRunner` 上注册 `before_provider_headers`。spawn-agent 的子代理 session 由 `createSubagentSession` 创建，`DefaultResourceLoader` 配置为 `noExtensions: true`，只注入 `subagentToolsExtension` 一个内联工厂；pi 的 `buildRequestOptions` 仅在 runner 存在该事件 handler 时才执行 header 变换，因此子代理请求不带 `Thread-Id`。

## Goals / Non-Goals

**Goals:**

- 子代理发出的每次 provider 请求都带 `Thread-Id`，值为该子代理 session 自己的 id。
- 注入逻辑只有一份实现，主会话与子代理不会各写一遍。

**Non-Goals:**

- 不改变 `Thread-Id` 的 header 名或主会话取值语义。
- 不为子代理增加父子关联 header（如 `Parent-Thread-Id`），网关侧协议不在本次范围内。
- 不把 `request-headers` 作为 `-e` 扩展路径加载到子会话，避免引入新的模块图。

## Decisions

**决策：把 `request-headers` 的默认导出直接加进 `createSubagentSession` 的 `extensionFactories`。**

`src/request-headers.ts` 的默认导出签名就是 `(pi: ExtensionAPI) => void`，与 `ExtensionFactory` 一致，SDK 的 `extensionFactories` 接受这种内联工厂且允许 Async。这样主入口扩展与子代理内联扩展共用同一份 handler，无需新增抽象。

备选：在 `subagentToolsExtension` 内部调用 `pi.on("before_provider_headers", ...)`。可行但把 header 逻辑耦合到工具工厂，且偏离每份内联扩展单一职责的结构，未采用。

**决策：`Thread-Id` 取子代理 session 自己的 id。**

handler 内 `ctx.sessionManager.getSessionId()` 在子代理的 runner 里返回其 in-memory session 的 id。子代理每次运行都是新 session，网关可区分单次运行；与 `request-headers` spec 的「当前会话」语义一致。父会话 id 仍可通过 spawn-agent 的 tool 调用记录关联，不需要新增 header。

备选：沿用父会话 id。会让一次子代理运行与父会话的请求无法区分，且需要在工厂闭包里透传父 id，收益不足，未采用。

## Risks / Trade-offs

- [每个子代理 session 都会注册一次 handler，扩展列表里可能多出一个内联项] → 工厂本身无额外注册（只有事件 handler），不影响工具与命令；若显示噪音明显，可用 `{ name: "request-headers", factory: requestHeaders, hidden: true }` 形式声明。
- [子代理的 in-memory session id 不落盘，网关无法从 session 文件回查] → 本次只要求追踪归属，id 本身由父会话的 spawn-agent 调用记录可关联；后续若需要更强关联再补父子 header。
