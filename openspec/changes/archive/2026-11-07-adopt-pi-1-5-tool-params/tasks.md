# Tasks

## 1. 依赖与枚举 schema

- [x] 1.1 把 `typebox` 从「靠 pnpm `publicHoistPattern` 提升」改为写进 `dependencies`；验证：`pnpm install` 成功，`pnpm why typebox` 显示它由本包直接依赖
- [x] 1.2 新增 `src/lib/string-enum.ts` 的 `stringEnum()`（`Type.Unsafe<T>({ type: "string", enum })`，支持 `description` / `default`）；验证：它的 JSON 输出与 pi-ai 的 `StringEnum()` 逐字一致（`node -e` 对比一次即可）
- [x] 1.3 `src/bwrap/core.ts`、`src/claude-code/grep.ts`、`src/claude-code/session-tools.ts`、`src/opencode/todo.ts` 改用 `stringEnum()`，去掉 `@earendil-works/pi-ai` 的 `StringEnum` 导入；验证：`pnpm exec tsc --noEmit` 对这 4 个文件无错误，且 Grep 的 `output_mode` 重新是可选参数

## 2. 总线 coercion

- [x] 2.1 `src/lib/tool-bus.ts` 的 `executeTool` / `executeCodemodeTool` 在解析参数前先做 `Value.Convert`，结构化结果的复核与配置解析保持不 coerce；验证：`pnpm exec tsc --noEmit` 通过

## 3. 测试

- [x] 3.1 `test/tool-bus.test.ts` 的「参数不合法」两个用例改用真正非法的输入（缺必填字段），因为 `{ text: 42 }` 现在会被 coerce 成 `"42"`；验证：`pnpm test` 通过

## 4. 集成验证

- [x] 4.1 跑全量检查：`pnpm check`、`pnpm lint`、`pnpm test` 全绿
- [x] 4.2 逐文件核对枚举 schema 的 JSON 与迁移前一致（`{ type: "string", enum: [...] }`，含 `description`）；验证：`rg -n "stringEnum\(" src` 的 4 个文件与 `Type.Unsafe` 产出对照，无 `anyOf` / `const`
