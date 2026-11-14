# 工具参数默认值的类型推断（`Default` + `StaticDefaulted`）

## Why

工具参数用 TypeBox 声明，但 `Static<T>` 只有「输入类型」一档：`default` 是注解，带默认值的字段在 handler 里永远是 `boolean | undefined`。运行期总线已经用 `Value.Default` 补值，类型却不知道，于是每个默认值都要在代码里再写一次 `?? CONSTANT`，默认值同时存在于 schema 与常量两处；漏写就悄悄丢掉默认值。

Zod 4 能表达这件事（`.default()` 输入可选、输出必有），但接入代价是新增依赖、把 66 个文件的 schema 全部改写、并补齐 codemode 声明渲染器对 Zod 派生形状的支持（`type` 数组、`additionalProperties`）。而实测表明 TypeBox 侧只需要一个小工具就能达到同样的类型效果：

- 这个问题上游报过多次（typebox #1035 / #1142 / #1134 / #1581），结论都是 by design：`default` 是注解，TypeBox 1.x 的 SchemaOptions 刻意不进泛型。
- 维护者给的官方绕法 `Type.Options(schema, { default: 100 })` 在 1.1.28–1.2.5 可用，**1.3.0 起被移除**；本仓库锁的 1.3.27 已经没有这个导出，因此需要自己提供等价的 helper。
- TypeBox builder 会把 `default` 从类型里丢掉（`Type.Boolean({ default: true })` 的类型是 `TBoolean`），所以默认值必须经一个携带类型的 helper 声明：`Default(Type.Boolean(), true)`。
- 有了类型上的 `default` 与 TypeBox 1.x 的 `'~optional': true` 标记，就能推出「有 default ⇒ 必填，无 default ⇒ 沿用原可选性」的解析后类型，并递归 object / array / `anyOf`。
- `Static<T>` 不变，pi 与 codemode 声明那一侧完全不受影响；`Value.Default` 继续在运行期补值。

## What Changes

- 新增 `src/lib/schema-defaults.ts`：`Default(schema, value)`（把默认值写进 schema 并在类型上保留字面量，同时使字段可省略——MUST NOT 再套 `Type.Optional`）与 `StaticDefaulted<T>`（把带默认值的字段推成必填、递归 object / array / `anyOf`，其余落回 `Static<T>`）。
- 工具总线把 `execute` 的参数类型从 `Static<TParams>` 换成 `StaticDefaulted<TParams>`（`register` / `registerCodemodeOnly` / `defineStructuredTool`）：工具作者不需要包装函数或 cast，`params.fail_fast` 直接是 `boolean`。
- 现有全部参数默认值迁到 `Default()`：`wait-*` 的 `fail_fast`、gh list 的 `state` / `limit`、`read-github-pr-comments` 的 `reviews`、workflow runs / releases 的 `limit`、两套文件工具集的 `read` / `Read` 的 `limit` 与 `offset`、opencode `edit` 的 `replaceAll`、opencode `glob` 的 `path`、`web_search` 的 `numResults`、`Grep` 的 `head_limit` / `output_mode` / `-n` / `offset`、两套 `Bash` 的 `timeout`、`talk-ask` 的 `timeoutMs`。handler 与读取层的 `?? DEFAULT_XXX` 兜底随之删除，`DEFAULT_XXX` 常量只在 schema 之外仍有使用点时保留。
- 共享参数 schema 下沉到 `src/lib`（`github-params.ts` 的 list 过滤参数、`web/search.ts` 的 `web_search` 参数），工具注册与 `src/lib` 的读取层从同一份 schema 推导类型：`limit` / `state` 这类字段不再在工具 schema 与读取层接口里各写一遍。
- codemode 声明渲染器把字段的数值与长度边界（`minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` / `minLength` / `maxLength` / `minItems` / `maxItems`）渲染成同名 JSDoc tag：上限只写在 schema 上，不再重复进 `description` 文本。
- **不新增依赖**，不改 `structuredSchema`。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `tool-registration`: 工具参数的默认值成为 schema 上的契约——省略参数时工具按 schema 的默认值执行，解析后的参数值对带默认值的字段必有值，工具实现 MUST NOT 再写兜底默认值。
- `codemode`: 字段的 `description`、`default` 与数值/长度边界 MUST 渲染进脚本声明里的 JSDoc 注释，模型才能看到默认值与取值边界。

## Impact

- `src/lib/schema-defaults.ts`（新增）：`Default`、`StaticDefaulted`；`src/lib/tool-bus.ts` 的 `execute` 参数类型改用 `StaticDefaulted`。
- `src/lib/github-params.ts`（新增）：gh list 过滤参数 schema 与派生的 `ListFilters`；`src/gh/base.ts` 转发它。
- `src/web/search.ts`：参数 schema 提成模块级 const，`SearchOptions` 从它派生。
- `src/codemode/declarations.ts`：字段注释渲染约束 tag。
- 各工具 schema 与 handler：gh wait / list / comments / workflow runs / releases、opencode `read`、`web_search`、claude-code `Grep`。
- 测试：`test/schema-defaults.test.ts`（类型与运行期补值）、`test/codemode-declarations.test.ts`（`@default` 与边界 tag）、`test/wait-pr-checks.test.ts`（省略 `fail_fast` 时仍 fail-fast 短路）、gh / opencode / web 相关测试随参数形状调整。
- `.agents/skills/typebox-schemas/SKILL.md`：默认值与声明渲染章节改写。
