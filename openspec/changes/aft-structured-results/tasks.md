# 任务

## 1 实现

- [x] 1.1 新增 `src/aft/schemas.ts`：四个 schema（字段来源写在文件头注释里）
- [x] 1.2 四个工具改用 `defineStructuredTool` 并声明 `structuredSchema`；成功结果带 `structuredResult`（`aftPayload` 去掉 envelope 的 `id`、补 `text`）
- [x] 1.3 实引擎 fixture：outline 单文件 / files、zoom；合成 fixture：callgraph 三个 op、search
- [x] 1.4 `test/aft-structured.test.ts`：真总线 + `executeTool`（顺带覆盖总线对载荷的 `Value.Parse` 复核），断言各 op 字段、envelope 的 `id` 不进载荷、以及「引擎加新字段仍通过」

## 2 验证

- [x] 2.1 `pnpm check`（tsc + prettier）
- [x] 2.2 `pnpm lint`
- [x] 2.3 `pnpm test`
- [x] 2.4 `openspec validate aft-structured-results --strict`

## 3 后续（不在本次）

- [ ] 3.1 在真实项目上采 callgraph / search 的实测响应，替换合成 fixture
- [ ] 3.2 若需要 outline 单文件模式的符号条目，向引擎侧提结构化输出需求
