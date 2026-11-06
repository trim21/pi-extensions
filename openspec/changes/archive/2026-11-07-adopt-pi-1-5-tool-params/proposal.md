# Proposal

## Why

pi 1.5.0 不再从 `@earendil-works/pi-ai` re-export TypeBox，`StringEnum()` 改为返回 `@earendil-works/pi-schema` 的 `Schema<T>`——一个裸 JSON 对象，没有 TypeBox 的 `~kind` 标记。本仓库有 4 个文件把它嵌进 TypeBox `Type.Object`（`src/bwrap/core.ts`、`src/claude-code/grep.ts`、`src/claude-code/session-tools.ts`、`src/opencode/todo.ts`），TypeBox 认不出这个 shape，于是这些字段的静态类型退化成 `unknown`，`Type.Optional()` 也不再被识别为可选：Grep 的 `output_mode` 从可选参数变成必填，`TodoWrite` 的状态索引直接编译失败。renovate PR #219（`@earendil-works/pi` 1.4.0 → 1.5.0）就卡在这里。

TypeBox 本身没有任何问题：它产出的就是普通 JSON Schema，pi 1.5 运行期用 pi-schema 校验任意 JSON Schema，TypeBox schema 照样通过（这也是同一份 PR 里 `test` 全绿、只有 `tsc` 红的原因）。真正断掉的只有「从 pi-ai 取 `StringEnum()` 塞进 TypeBox」这一种混用。

## What Changes

- 4 个文件的枚举参数改用 TypeBox 自己的表达，产出与 `StringEnum()` 相同的 `{ type: "string", enum: [...] }`：新增 `src/lib/string-enum.ts` 的 `stringEnum()`，内部走 `Type.Unsafe<T>`，支持 `description` / `default`；4 个文件不再从 `@earendil-works/pi-ai` 导入 `StringEnum`。
- **总线补 coercion**：pi 1.5 起，模型调用的参数校验会先把参数 coerce 到 schema（`"3"` → `3`、单值包成数组），总线的 codemode 调用路径要给出相同结论——`executeTool` / `executeCodemodeTool` 在解析参数前先做 TypeBox 的 `Value.Convert`。结构化结果的复核**不** coerce，输出不该被静默转换。
- **依赖声明**：`typebox` 现在只靠 pnpm `publicHoistPattern` 从 `pi-coding-agent` 提升，`src/` 里 65 个文件直接 `import` 它。改为显式写进 `dependencies`。
- `peerDependencies` 保持 `^1.4.0`：这次改动不使用任何 1.5 专有 API，1.4 与 1.5 都成立。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `tool-registration`: 「工具总线」的参数校验条款补充 coercion 语义——总线对参数的接受/拒绝结论与 pi 对同一次模型调用的结论一致；并明确枚举参数以 `enum` 形式出现在 schema 里、未声明字段的处理方式不因本次改动而改变。

## Impact

- 代码：`src/bwrap/core.ts`、`src/claude-code/grep.ts`、`src/claude-code/session-tools.ts`、`src/opencode/todo.ts`（枚举 schema）、`src/lib/string-enum.ts`（新增）、`src/lib/tool-bus.ts`（参数 coerce）。
- 测试：`test/tool-bus.test.ts`（「参数不合法」用例改用真正非法的输入，新增 coerce 一致性用例）、`test/claude-code-tools.test.ts`（Grep `output_mode` 可选性回归）。
- 依赖：`package.json`、`pnpm-lock.yaml`。
- 取代 renovate PR #219（同一份版本升级，但它修不掉这些类型错误）。
