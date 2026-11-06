# Design

## Context

见 `proposal.md` 的 Why。决定方案的现状事实：

- 65 个 `src/` 文件 `import` `typebox`，其中 1598 处 `Type.*`。pi 1.5 的类型里 `ToolDefinition<TParams extends TSchema>` 的 `TSchema` 是 TypeBox 的空接口，所以 TypeBox schema 一直能正常传给 `registerTool`，静态推断也正常。
- pi 1.5 运行期用 `@earendil-works/pi-schema` 的 `compile()` 校验工具参数，它接受任意 JSON Schema——TypeBox 产出的对象就是 JSON Schema，因此**运行时从一开始就是兼容的**。
- 唯一断掉的是 4 处 `StringEnum()`（pi-ai，1.5 起返回 pi-schema `Schema<T>`）被嵌进 TypeBox `Type.Object`：TypeBox 靠 `~kind` 符号做静态推断，认不出来源的 shape 就退化成 `unknown`，`Type.Optional()` 也随之失效。
- 总线在 codemode 路径上自己复核参数，用的是 TypeBox `Value.Parse`（不 coerce）；而 pi 1.5 校验模型调用时带 coercion。

## Goals / Non-Goals

**Goals:**

- 让 4 个文件的枚举参数恢复正确的静态类型与可选性，且发给模型的 JSON 与今天完全一致。
- 总线与 pi 对同一组参数给出相同结论。

**Non-Goals:**

- 不把工具 schema 迁到 pi-schema（41 个文件、约 94 个 schema，运行时没有任何收益）。
- 不改变任何工具的参数语义、输出 schema 或文案。
- 不给配置与外部数据的解析加 coercion。

## Decisions

**1. 保留 TypeBox，只修混用点。**
`StringEnum()` 换成 TypeBox 原生表达后，4 个文件的 schema 恢复成一个纯 TypeBox 对象，静态推断与可选性都回来了；pi 侧无论 1.4（TypeBox 校验）还是 1.5（pi-schema 校验）都照常接受。替代方案（把工具 schema 整体迁到 pi-schema）被否决：运行时收益为零，却要重写 41 个文件并处理 `obj()` 默认闭合等语义差异。

**2. 枚举用 `Type.Unsafe<T>({ type: "string", enum: [...] })`，不用 `Type.Union` + `Type.Literal`。**
两者都能给出正确的静态类型，但 `Type.Union` + `Type.Literal` 产出 `anyOf` + `const`（`StringEnum()` 的存在就是为了避开它——部分 provider 不支持这种组合），`Type.Unsafe` 产出的 `{ type: "string", enum: [...] }` 与今天线上发给模型的 JSON 逐字一致，`src/codemode/declarations.ts` 的 `renderType` 也继续走 `enum` 分支。封装成 `src/lib/string-enum.ts` 的 `stringEnum()`（签名与 pi-ai 原来的 `StringEnum` 相同，支持 `description` / `default`），避免 4 个地方重复写 JSON 形状。

**3. 只有「工具参数」这条路 coerce，结构化结果不 coerce。**
pi 对模型调用的参数校验带 coercion，总线在 codemode 路径上替它校验，口径要一致，所以参数先 `Value.Convert` 再 `Value.Parse`。输出侧相反：`structuredResult.value` 不匹配就应当报错，静默转换会把「工具写错了返回形状」藏起来。配置与外部数据的 `parseWithSchema` 也不动——配置文件里 `"true"` 被悄悄当成 `true` 正是要避免的。

**4. `typebox` 进 `dependencies`。**
`src/` 有 65 个文件直接 `import` 它，却从来没在 `package.json` 声明过，靠 pnpm 的 `publicHoistPattern` 从 `pi-coding-agent` 提升——发布后换一个包管理器或 pnpm 配置就会变成 `Cannot find package`。它承载运行时行为（配置解析、参数校验），属于 `dependencies`。

**5. `peerDependencies` 保持 `^1.4.0`。**
改动后不使用任何 1.5 专有 API。dev 依赖按 renovate 的升级锁到 `1.5.0`（CI 测最新），peer 范围不跟着抬。

## Risks / Trade-offs

- [TypeBox 的 `Value.Convert` 与 pi-schema 的 coercion 规则不是同一个集合（例如 `"3.5"` 对 `integer` 的处理、`null` → `"null"`）] → 两者在大面上一致；差异只在极端输入上出现，且方向是「总线比 pi 更严格或更宽松」，不影响正常调用。若真出现不一致，以 pi 的结论为准再调，不在这轮预先兜。
- [参数路径变宽松：以前被拒的输入（如 `{ text: 42 }`）现在会被接受] → 这是与 pi 对齐的预期结果，`test/tool-bus.test.ts` 的「参数不合法」用例改用真正非法的输入，并新增一条 coerce 一致性用例锁住新语义。
- [`Type.Unsafe` 不做静态校验，「JSON 与 `StringEnum()` 一致」靠人写对] → 由 `test/claude-code-tools.test.ts` 的 `output_mode` 可选性回归与 `bwrap` / `todowrite` 的现有测试兜住；`stringEnum()` 只有一处实现。
- [renovate PR #219 与本改动并存] → 本分支从它的提交出发，合并后 renovate 会因依赖已达目标版本自动关闭。

## Migration Plan

1. `package.json`：`typebox` 进 `dependencies`。
2. `src/lib/string-enum.ts` + 4 个文件替换 `StringEnum`。
3. `src/lib/tool-bus.ts` 参数 coerce。
4. 测试调整与回归，跑 `pnpm check` / `pnpm lint` / `pnpm test`。

回滚：单分支单 PR，未发布前 revert 即可；`peerDependencies` 未变，回滚不需要动版本约束。

## Open Questions

无。
