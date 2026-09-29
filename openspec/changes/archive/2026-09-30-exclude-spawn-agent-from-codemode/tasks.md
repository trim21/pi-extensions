# Tasks

## 1. codemode 可调用集合排除 spawn-agent

- [x] 1.1 `src/codemode/tool.ts`：`collectTools` 的排除集合加入 `spawn-agent`（与 `codemode` 自身一起排除），说明注释同步更新
- [x] 1.2 `src/codemode/tool.ts`：文件头注释的「可调用集合」描述同步更新

## 2. 测试

- [x] 2.1 `test/codemode-tool.test.ts`：注册一个 `spawn-agent` 桩工具，断言工具描述里不含它的参数声明
- [x] 2.2 `test/codemode-tool.test.ts`：断言脚本调用 `spawn-agent` 时以错误失败，且桩工具未被调用

## 3. 验证

- [x] 3.1 `pnpm test` 通过
- [x] 3.2 `pnpm check` 通过，本次改动文件的 `eslint` 通过（全仓 `pnpm lint` 的报错来自并行任务改动的 `test/aft-tools.test.ts`）
