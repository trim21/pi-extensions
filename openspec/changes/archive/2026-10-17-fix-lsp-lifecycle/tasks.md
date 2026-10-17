# Tasks

- [x] 1.1 监听器失败统一关闭并移出监听表，非资源耗尽失败允许 reconcile 重建。
- [x] 1.2 监听器失败提示按 root 去重，重建成功后清除记录。
- [x] 1.3 `spawn` 先执行 setup，再检查 bin。
- [x] 2.1 补非 ENOSPC 失败与「只有 setup 没有 bin」的回归测试。
- [x] 3.1 `pnpm exec vitest run test/lsp-config.test.ts test/lsp-server-config.test.ts` 通过。
- [x] 3.2 `pnpm lint` 与 `pnpm check` 通过。
