# Tasks

## 1. 子代理注入 Thread-Id

- [x] 1.1 在 `src/spawn-agent.ts` 的 `createSubagentSession` 中把 `request-headers` 的默认导出加入 `extensionFactories`（位于 `subagentToolsExtension` 之前），并确认 `pnpm check` 通过

## 2. 文档与验证

- [x] 2.1 更新 `README.md` 的 request-headers 小节，说明子代理请求同样携带 `Thread-Id`（取子会话自己的 id）；人工核对与实现一致
- [ ] 2.2 运行 `pnpm check`、`pnpm lint`、`pnpm test` 全部通过

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
