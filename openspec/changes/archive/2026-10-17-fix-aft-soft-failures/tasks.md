# Tasks

## 1. 修复

- [x] 1.1 共享软失败码集合并传给 outline / zoom / search。
- [x] 1.2 `range` / `callRef` / outline 文件条目的引擎字段改为可选。
- [x] 1.3 guidelines 移除对条件注册的 `aft_search` 的引用。

## 2. 测试

- [x] 2.1 省略 `lines` / `range` 字段时结构化结果仍通过复核。
- [x] 2.2 outline / zoom / search 都把软失败码传给 `callAftTool`。

## 3. 验证

- [x] 3.1 `pnpm exec vitest run test/aft-structured.test.ts` 通过。
- [x] 3.2 `pnpm lint` 与 `pnpm check` 通过。
