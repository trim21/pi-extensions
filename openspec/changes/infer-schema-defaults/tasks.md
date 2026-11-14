# Tasks

## 1. 类型工具与总线参数类型

- [x] 1.1 新增 `src/lib/schema-defaults.ts`：`TDefaulted` / `Default()` / `StaticDefaulted<T>`，并把总线的 `register` / `registerCodemodeOnly` / `defineStructuredTool` 的 `execute` 参数类型改成 `StaticDefaulted<TParams>`，验证 `pnpm check` 通过
- [x] 1.2 新增 `test/schema-defaults.test.ts`：用 `@ts-expect-error` 锁定「有默认值的字段必填、无默认值的可选字段仍可选、嵌套对象 / 数组元素 / `anyOf` 分支递归」，并断言 `Value.Default` 在运行期补出同样的值；验证 `pnpm exec vitest run test/schema-defaults.test.ts` 通过
- [x] 1.3 同一测试文件覆盖两条执行路径：`executeTool` 与 `executeCodemodeTool` 省略默认值参数时，`execute` 收到补好的值；验证测试通过
- [x] 1.4 `Default()` 内部调用 `Type.Optional`，因此字段可省略；确认代码里不再出现 `Type.Optional(Default(...))`，skill 文档同步这条约束

## 2. 迁移现有默认值

- [x] 2.1 `src/gh/schemas.ts` 的 `checksWaitFailFastSchema` 改用 `Default(Type.Boolean(...), true)`；`wait-pr-checks` / `wait-commit-checks` 的入参类型改用 `StaticDefaulted`，删除 `??` 兜底；验证 `pnpm check` 通过
- [x] 2.2 迁移 gh list 的 `state` / `limit`、`read-github-pr-comments` 的 `reviews`、workflow runs / releases 的 `limit`、两套文件工具集的 `read` / `Read` 的 `limit` 与 `offset`、opencode `edit` 的 `replaceAll`、opencode `glob` 的 `path`、`web_search` 的 `numResults`、claude-code `Grep` 的 `head_limit` / `output_mode` / `-n` / `offset`、两套 `Bash` 的 `timeout`、`talk-ask` 的 `timeoutMs`，删除 handler 里的 `?? DEFAULT_XXX`、手写取值范围校验与对应的描述文案
- [x] 2.5 复查残留的 `??`：`Grep` 的 `context ?? -C` 是互斥参数优先级、opencode grep 的错误文案、`web_search` 的 `queries ?? []` 都不是默认值，保持原样
- [x] 2.3 读取层（`src/lib/github.ts` / `github-reads.ts`）的 `state` / `limit` 改成必填，删除 `limitOf` 一类的兜底参数；`web/search.ts` 的 `searchWeb` 要求调用方传入已补默认值的 `SearchOptions`
- [x] 2.4 删除 `clampLimit` / `clampNumResults` 这类静默截断，边界改用 schema 的 `minimum` / `maximum`；更新依赖截断的测试

## 3. 共享参数 schema 下沉

- [x] 3.1 新增 `src/lib/github-params.ts`：list 过滤参数 schema + 派生的 `ListFilters`；`src/gh/base.ts` 用 `export ... from` 转发，工具与读取层都从它取类型
- [x] 3.2 `src/web/search.ts` 把 `web_search` 参数提成模块级 const，`SearchOptions` 从 schema 派生，工具注册直接传它
- [x] 3.3 确认工具侧不再有与 schema 同名的第二份 interface；`pnpm check` 通过

## 4. codemode 声明渲染器

- [x] 4.1 `src/codemode/declarations.ts` 的 `fieldComment` 渲染 `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` / `minLength` / `maxLength` / `minItems` / `maxItems` 为同名 JSDoc tag，并更新注释说明哪些注解不渲染
- [x] 4.2 `test/codemode-declarations.test.ts` 增加边界 tag 用例；验证 `pnpm exec vitest run test/codemode-declarations.test.ts` 通过
- [x] 4.3 把重复进 `description` 的边界文案去掉（`web_search` 的 `max 50`、gh list 的 `upper bound 100`），`MAX_NUM_RESULTS` / `GH_LIST_MAX_LIMIT` 常量随之删除

## 5. 文档

- [x] 5.1 更新 `.agents/skills/typebox-schemas/SKILL.md`：`Default()` + `StaticDefaulted<T>` 写法、`Default()` 自带 optional、默认值不再抽常量、渲染器输出 `@default` 与边界 tag、`pattern` / `format` 仍靠 `description`；验证 `pnpm exec prettier --check` 通过
- [x] 5.2 同步 `openspec/changes/infer-schema-defaults/` 的 proposal / design / spec delta，并补 `codemode` 的 delta（字段注解渲染）；验证 `openspec validate infer-schema-defaults` 通过

## 6. 集成验证

- [x] 6.1 运行 `pnpm check`、`pnpm lint`、`pnpm test`，确认只有既有的 `test/lsp-e2e-rename.test.ts` 失败，并记录结果
