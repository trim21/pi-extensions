# Tasks

## 1. 修复

- [x] 1.1 `download-github-release-assets`：无资产判定改用 release API 的资产清单，不再看缓存目录内容。
- [x] 1.2 `runGh`：用 `exitCode` / `signalCode` 判断进程是否已退出，SIGTERM 后 5 秒仍存活则发 SIGKILL；退出时清理该定时器。
- [x] 1.3 `read-github-ci-logs`：未开始状态扩展为 `queued` / `waiting` / `requested` / `pending`，统一返回结构化失败。

## 2. 测试

- [x] 2.1 release：缓存目录非空时，无资产的 release 仍返回 `{ ok: false }`。
- [x] 2.2 `runGh`：进程不响应 SIGTERM 时 5 秒后升级到 SIGKILL。
- [x] 2.3 `read-github-ci-logs`：四种未开始状态都返回「has not started yet」。

## 3. 验证

- [x] 3.1 `pnpm exec vitest run test/run-gh-timeout.test.ts test/gh-readonly-release.test.ts test/ci-logs.test.ts test/gh-process.test.ts` 通过。
- [x] 3.2 `pnpm lint` 与 `pnpm check` 通过。
- [x] 3.3 `openspec validate fix-gh-edge-cases --strict` 通过。
