# Tasks

## 1. 解析与挂载

- [x] 1.1 `src/bwrap/core.ts`：`resolveBwrap` 在 `fs.mode === "readonly"` 时把 `extraWritablePaths` 置空，更新注释。
- [x] 1.2 `README.md`：fs 模式表写明 readonly 忽略 `writablePaths` 与 `extraWritablePaths`。

## 2. 测试

- [x] 2.1 `test/bwrap.test.ts`：`resolveBwrap` 的 readonly 用例声明 `extraWritablePaths`，断言解析结果为 `[]`。
- [x] 2.2 `test/bwrap.test.ts`：`buildBwrapArgs` 断言 readonly 下不为额外可写路径生成 `--bind-try`。
- [x] 2.3 `test/bwrap-sandbox.test.ts`：readonly 集成用例配置 `extraWritablePaths` 指向 workspace 内目录，断言写入仍失败。

## 3. 验证

- [x] 3.1 `pnpm exec vitest run test/bwrap.test.ts test/bwrap-sandbox.test.ts` 通过。
- [x] 3.2 `pnpm lint` 与 `pnpm check` 通过。
- [x] 3.3 `openspec validate fix-bwrap-readonly-extra-writable --strict` 通过。
