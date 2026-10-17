# Tasks

- [x] 1.1 vision：provider / model 都配置才注册。
- [x] 1.2 session-name：跳过非 user 消息。
- [x] 1.3 web_fetch：超时预算覆盖整次抓取。
- [x] 1.4 codemode：空 active 列表求交；描述不点名 Bash。
- [x] 2.1 补 vision / session-name / codemode 的回归测试。
- [x] 3.1 `pnpm exec vitest run test/vision-agent.test.ts test/session-name.test.ts test/codemode-tool.test.ts test/web-fetch.test.ts` 通过。
- [x] 3.2 `pnpm lint` 与 `pnpm check` 通过。
