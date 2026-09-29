# Tasks

## 1. 限流实现

- [x] 1.1 在 `src/spawn-agent.ts` 用 lodash-es 的 `throttle(fn, 100, { trailing: true })` 包装 `emitUpdate`，间隔用本地常量（注释说明与 bash 工具一致）；验证：`pnpm exec tsc --noEmit` 通过，且 `emitUpdate` 的每个事件调用点仍只调这一个函数
- [x] 1.2 更新 `src/spawn-agent.ts` 头部注释里关于进度流式的描述，说明进度推送按 100ms 限流、最终态不丢；验证：注释与实现一致

## 2. 测试适配

- [x] 2.1 调整 `test/spawn-agent.test.ts` 的 `runWithEvents` helper：等待限流窗口结束、让 trailing 帧送达后再断言，使既有进度断言仍取到面板最终态；验证：`pnpm exec vitest run test/spawn-agent.test.ts` 通过

## 3. 集成验证

- [x] 3.1 运行 `pnpm check`、`pnpm lint`、`pnpm test` 全绿；验证：三条命令输出无错误
