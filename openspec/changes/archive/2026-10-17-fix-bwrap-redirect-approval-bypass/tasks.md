# Tasks

## 1. 重定向判定

- [x] 1.1 `src/bwrap/approval-rules.ts`：`fileRedirectWritesToFile` 增加 `>&` 分支，右操作数是 `number` 或 `-` 时视为 fd 复制，其余视为写文件；更新操作符注释。
- [x] 1.2 保持 `>&-`、`<&`、`>&1` 的现有行为不变。

## 2. 测试

- [x] 2.1 `test/approval-rules.test.ts`：解析层断言 `echo hi >& file` / `echo hi >&$fd` 为文件输出重定向，`2>&1` / `>&2` / `>& 2` / `>& -` 不是。
- [x] 2.2 审批层断言 `allow echo *` 下 `echo hi >& file` 返回 `undefined`，`echo hi >&2` 仍返回 `allow`。

## 3. 验证

- [x] 3.1 `pnpm exec vitest run test/approval-rules.test.ts` 通过。
- [x] 3.2 `pnpm lint` 与 `pnpm check` 通过。
- [x] 3.3 `openspec validate fix-bwrap-redirect-approval-bypass --strict` 通过。
