# Tasks

- [x] 1.1 `runGh` 去掉 SIGKILL 升级，超时 / 中止只发 SIGTERM。
- [x] 1.2 删除 `sigkillId` 与升级测试，补「只发 SIGTERM」断言。
- [x] 1.3 直接更新 `gh-readonly` spec 的 SIGKILL 描述。
- [x] 2.1 `pnpm exec vitest run test/run-gh-timeout.test.ts test/gh-process.test.ts` 通过。
- [x] 2.2 `pnpm lint` 与 `pnpm check` 通过。
