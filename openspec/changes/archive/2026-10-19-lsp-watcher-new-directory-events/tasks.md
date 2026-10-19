# Tasks

## 1. 目录创建后的补扫

- [x] 1.1 重构 `src/lib/lsp/watcher.ts` 的目录事件处理，目录 created 事件触发递归扫描并通过现有 `push()` 投递文件 created、把目录记入 `seenDirectories`；用新增用例“目录创建后立即写入的文件必须可见”（`mkdir` 后不 sleep 直接 `writeFile`）验证修复前失败、修复后稳定通过
- [x] 1.2 补扫复用忽略语义：命中内置 glob、配置 `ignore` 与绝对路径 `ignoreDirs` 的子树不进入、不投递；用新增用例“移入树中的 node_modules 内容不投递”验证
- [x] 1.3 更新 `src/lib/lsp/watcher.ts` 顶部行为说明（目录扫描、重复投递允许），确认与实现一致

## 2. 移入子树的递归监听

- [x] 2.1 为含子目录的新建目录建立子订阅并保持事件回调一致，删除子订阅根（或其祖先被删除）与 `stop()` 时退订；用新增用例“整树移入后嵌套目录内的写入可见、删除后不再有事件”验证
- [x] 2.2 子订阅失败处理：`ENOENT` / `ENOTDIR` 静默跳过，其余错误走 `handleError`，轮询降级生效后不再建立子订阅；验证现有降级用例与全量 `test/lsp-watcher.test.ts` 通过
- [x] 2.3 将现有“常见缓存 / 工具产物目录被忽略，out / bin / obj 不忽略”用例改为不依赖固定时序，重复运行 20 次验证不再 flaky

## 3. 集成验证

- [x] 3.1 运行 `pnpm vitest run test/lsp-watcher.test.ts`、`pnpm check`、`pnpm lint`，确认通过
- [x] 3.2 运行 `pnpm test` 全量测试，确认无回归

## Workflow follow-up

- 实现完成并验证后归档本 change，并把 delta 同步进 `openspec/specs/lsp/spec.md`。
