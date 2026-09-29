# Tasks

## 1. 项目根改为会话工作目录

- [x] 1.1 `src/aft/index.ts`：用户级配置路径改用无参的 `resolveCortexKitUserConfigPath()`，去掉工厂级的 `process.cwd()`
- [x] 1.2 `src/aft/index.ts`：`createAftState` 改用会话 `ctx.cwd`；工具上下文收敛为 `{ getState }`，不再携带路径基准
- [x] 1.3 `src/aft/index.ts`：更新文件头注释，说明项目根来自会话工作目录

## 2. 工具侧路径基准与转发

- [x] 2.1 `src/aft/tools.ts`：`AftToolContext` 去掉 `cwd`，取 bridge 用状态里的项目根
- [x] 2.2 `src/aft/tools.ts`：`aft_outline` 的 target 一律转发解析后的绝对路径（目录模式不再传原始相对路径）

## 3. 测试

- [x] 3.1 `test/aft-index.test.ts`：`createAftState` 断言改为会话 cwd（与进程 cwd 取不同假值）
- [x] 3.2 新增回归测试：目录模式相对 target 转发为会话 cwd 下的绝对路径

## 4. 验证

- [x] 4.1 `pnpm test` 通过
- [x] 4.2 `pnpm check` 与 `pnpm lint` 通过
