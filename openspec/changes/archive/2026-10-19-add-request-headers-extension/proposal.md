# Proposal

## Why

当前只有一个放在 `~/.pi/agent/extensions/header-req-id.ts` 的个人扩展，用来给所有 provider 请求附加会话 id。它没有纳入本仓库，无法随 npm 包分发，也不会跟随仓库的版本管理与格式化/类型检查；换机器或重装环境时需要手工复制。

## What Changes

- 新增独立扩展入口 `src/request-headers.ts`：监听 pi 的 `before_provider_headers` 事件，把 `Thread-Id` 请求头设为当前会话 id（`ctx.sessionManager.getSessionId()`），用于网关侧的请求追踪与归属。会话 id 在每次请求发生时读取，天然跟随 resume / fork / `/new` 后的会话切换。
- 在 `package.json` 的 `pi.extensions` 中单独登记该入口；它不注册任何工具，因此**不**经过 `src/index.ts` 的工具总线注册。
- 同步 README 的扩展概览与说明。
- `~/.pi/agent/extensions/header-req-id.ts` 由用户在本地删除，避免同一行为被加载两次。

## Capabilities

### New Capabilities

- `request-headers`: 每次 provider 请求都携带当前会话 id 的 `Thread-Id` 请求头。

### Modified Capabilities

无。

## Impact

- 代码：新增 `src/request-headers.ts`；`package.json` 的 `pi.extensions` 增加 `src/request-headers.ts`。
- 行为：所有 provider 请求（含子代理与后台调用）的 `Thread-Id` 请求头被覆盖为当前会话 id；pi 官方 `session-id` 一类的请求头不受影响，除非同名。
- 依赖：无新增依赖，仅使用 `@earendil-works/pi-coding-agent` 的 `ExtensionAPI` 与 `before_provider_headers` 事件。
- 测试：无。扩展只做一次同步赋值，业务逻辑为空；用户明确要求不添加测试。
- 文档：`README.md` 扩展概览与对应小节，`openspec/specs/request-headers/spec.md`。
