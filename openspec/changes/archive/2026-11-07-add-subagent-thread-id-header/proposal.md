# Proposal

## Why

主会话的 provider 请求会带上 `Thread-Id` 会话追踪头，但 spawn-agent 创建的子代理 session 不会：它用 `DefaultResourceLoader({ noExtensions: true })` 只加载内联工具工厂，`request-headers` 作为独立扩展入口不在子代理的模块图里，`before_provider_headers` 没有监听者。网关因此无法追踪和归属子代理发出的请求，与此前 proposal 中「所有 provider 请求（含子代理与后台调用）」的意图不一致。

## What Changes

- `request-headers` 的注入逻辑作为内联扩展工厂加入子代理 session 的 `extensionFactories`，子代理请求同样携带 `Thread-Id`。
- `Thread-Id` 取子代理自己 in-memory session 的 id（每次子代理运行独立可区分），而不是父会话 id。
- 补充测试：`request-headers` 的写入/覆盖行为，以及子代理 session 确实注册了该 handler。
- 同步 `request-headers` spec，明确内联子会话（子代理）也适用。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `request-headers`: 请求携带会话 id 的要求扩展到子代理等内联 session，并明确取该 session 自己的 id。

## Impact

- `src/spawn-agent.ts`：`createSubagentSession` 的 `extensionFactories` 增加 `request-headers` 工厂。
- `src/request-headers.ts`：默认导出即为 `ExtensionFactory`，可直接复用，预计无需改动或仅调整导出注释。
- `test/request-headers.test.ts`（新增）、`test/spawn-agent.test.ts`（补充断言）。
- 对外行为：子代理发出的 provider 请求新增 `Thread-Id`；网关侧可按子会话 id 追踪。无 breaking change。
