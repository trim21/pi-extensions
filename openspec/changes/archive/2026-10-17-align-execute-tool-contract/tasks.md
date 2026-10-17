# Tasks

## 1. 契约与实现

- [x] 1.1 spec 明确 `executeTool` 只拒绝代码层注册的脚本型 codemode-only；配置路径的 codemode-only 普通工具可以执行。
- [x] 1.2 `src/lib/tool-bus.ts`：`executeTool` 保留工具结果自身的 `isError`，不再无条件置为 false。

## 2. 测试

- [x] 2.1 `test/tool-bus.test.ts`：`executeTool` 执行配置路径的 codemode-only 工具并拿到结构化结果。
- [x] 2.2 `test/tool-bus.test.ts`：`executeTool` 保留工具返回的 `isError: true`；脚本工具仍被拒绝。

## 3. 验证

- [x] 3.1 `pnpm exec vitest run test/tool-bus.test.ts` 通过。
- [x] 3.2 `pnpm lint` 与 `pnpm check` 通过。
- [x] 3.3 `openspec validate align-execute-tool-contract --strict` 通过。
