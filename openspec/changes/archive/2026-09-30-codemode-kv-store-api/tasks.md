# Tasks

## 1. 脚本接口

- [x] 1.1 `src/codemode/prelude.ts`：把 `store` / `load` 改名为 `set` / `get`（含错误文案里的函数名），新增 `store.list()` 返回升序键；验证：`test/codemode.test.ts` 覆盖写入/读取/删除/枚举与容量错误
- [x] 1.2 `src/codemode/declarations.ts`：TS 声明改为 `declare const store: { set(...); get(...); list(): string[] }`；验证：`test/codemode-tool.test.ts` 断言描述里出现三个声明
- [x] 1.3 `src/codemode/tool.ts`：工具描述里 `store`/`load` 的用法说明改为 `store.set`/`store.get`/`store.list`；验证：同上

## 2. 测试与文档

- [x] 2.1 `test/codemode.test.ts`：脚本样例改名，新增 `store.list()`（含删除后的结果）用例；验证：`pnpm exec vitest run test/codemode.test.ts`
- [x] 2.2 `test/codemode-tool.test.ts`：脚本样例改名，store 往返与 details 断言不变；验证：`pnpm exec vitest run test/codemode-tool.test.ts`
- [x] 2.3 README 与 `openspec/specs/codemode/spec.md` 同步新接口；验证：`pnpm check`、`openspec validate codemode --strict`
- [x] 2.4 全量验证：`pnpm check`、`pnpm lint`、`pnpm test`；重建 `src/codemode/worker.js`（prelude 变更必须重新打包）
