# Design

## Context

见 `proposal.md` 的 Why。与实现相关的现状：

- 参数 schema 全部用 TypeBox 声明，`Static<TParams>` 决定 `execute` 的参数类型；pi 的 `ToolDefinition` 泛型要求 `parameters` 是 TypeBox 的 `TSchema`。
- 总线在 `parseToolArguments` 里已经做 `Value.Convert → Value.Default → Value.Parse`，所以运行期默认值本来就补齐了，缺的只是类型。
- TypeBox 1.x 的可选标记是字符串键 `'~optional': true`（`node_modules/typebox/build/type/types/_optional.d.mts`），schema 本身是纯 JSON 对象，`~kind` / `~optional` 都是字符串键，可以安全 spread。
- 实测：`Type.Boolean({ default: true })` 的类型是 `TBoolean`，`default` 不进类型；因此「有默认值」这个事实必须由我们自己的 helper 在类型上保留。

## Goals / Non-Goals

**Goals:**

- 带默认值的参数在 handler 侧类型必填，省略 `?? 常量`。
- 默认值只写一次（schema 上），且同时进 JSON Schema（模型可见）与运行期补值。
- 现有参数默认值全部按同一机制声明，不保留 `DEFAULT_XXX` 常量式的第二份来源。
- 不新增依赖，不动 `structuredSchema`。

**Non-Goals:**

- 不引入 Zod 或其它 schema 库；不做输入/输出的通用类型分离（只有「默认值 ⇒ 必填」这一条）。
- 不改 `structuredSchema` 的输出校验。

## Decisions

### 用 `Default()` 承载类型上的默认值，而不是扩展 TypeBox

`Type.Boolean({ default: true })` 丢类型是 TypeBox 的固有行为，无法在 `Infer` 层补救。因此默认值走一个 helper：

```ts
type TDefaulted<T extends TSchema, V> = T & { readonly default: V };

export function Default<T extends TSchema, const V>(schema: T, value: V): TDefaulted<T, V> {
  return { ...schema, default: value };
}
```

`const V` 让字面量保留在类型上；运行期把 `default` 写进 schema，`Value.Default` 与 codemode 的 `@default` 渲染都照旧工作。`Default()` 返回的类型自带 `'~optional': true`（见下），所以它**就是**可选字段，MUST NOT 再套一层 `Type.Optional(...)`——外层 optional 会与 `default` 一起进入类型，`StaticDefaulted` 的「有 default ⇒ 必填」判定虽然仍成立，但 `Static<T>` 与 pi 侧 `required` 的语义会变成两处各说一遍，容易误读成「可选且带默认值」两种独立事实。

上游背景（决定不依赖 TypeBox 自带机制的依据）：

| Issue / 来源                                                                                    | 时间    | 结论                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| [#1035](https://github.com/sinclairzx81/typebox/issues/1035)                                    | 2024-10 | 带 `default` 的字段在 `Static` 里仍是 `?`。维护者：`default` 是 JSON Schema 注解，验证器不保证填值，TypeBox 不据此推断。  |
| [#1142](https://github.com/sinclairzx81/typebox/issues/1142)                                    | 2025-01 | 能否在编译期检测 `default`。维护者：1.x 刻意不把 SchemaOptions 编进泛型，给了自定义 `Options` 类型的原型。                |
| [#1134](https://github.com/sinclairzx81/typebox/issues/1134)                                    | 2025-01 | 正是「输入 `foo?: string`、输出 `foo: string`」的需求；维护者给出 `Options` / `RecursiveMap` 原型（含 `StaticDefault`）。 |
| [#1581](https://github.com/sinclairzx81/typebox/issues/1581)                                    | 2026-04 | 最新一次；维护者正式推荐 `Type.Options(schema, { default: 100 })`，并称 1.1.28 起可用。                                   |
| [#1581 我们的追问](https://github.com/sinclairzx81/typebox/issues/1581#issuecomment-6883874101) | 2026-11 | 实测 `Type.Options` 在 1.3.0 被移除，已回帖确认并询问 1.3.x 的替代方案。                                                  |

版本实测（`Object.keys(Type).filter(k => /option/i.test(k))`）：

| 版本                         | `Type.Options`                                                         |
| ---------------------------- | ---------------------------------------------------------------------- |
| 1.1.28 / 1.2.0 / 1.2.5       | 有（`type/action/with` 的 `TOptions`）                                 |
| 1.3.0 / 1.3.27（本仓库锁定） | 无；`typebox` 根导出与 `typebox/type` 都只剩 `IsOptional` / `Optional` |

1.3.0 的 changelog 只列了 `Base`、`Awaited`/`Promise`/`AsyncIterator`/`Iterator`、`Mutate` 三项 deprecation，没有提 `Options`——它是被静默移除的。`example/prototypes/options.ts` 与 `RecursiveMap` 原型文件现在都是 404。

结论：本设计的 `Default()` 是 1.3.x 里已删除的 `TOptions` 的最小等价物，`StaticDefaulted<T>` 对应 #1134 里维护者展示、但已从仓库删除的 `StaticDefault`。等上游给出新的官方机制（或恢复 `Type.Options`）时再替换，见 Risks。

替代方案：把 typebox 降到 1.2.5 以使用 `Type.Options`——与 peerDependency `*` 及 pi 的版本不一致，不可取；给每个参数手写 interface 并在 handler 里断言必填——重复且会漂移；用 Zod——见 proposal，收益只有类型，代价是依赖与全量迁移。

### `StaticDefaulted<T>` 的推断规则

```ts
type StaticDefaulted<T> = T extends { type: "object"; properties: infer P }
  ? ResolveObject<P>
  : T extends { type: "array"; items: infer I }
    ? Array<StaticDefaulted<I>>
    : T extends { anyOf: infer U }
      ? StaticDefaulted<U[number]>
      : Static<T>;
```

`ResolveObject` 把属性分三组：有 `default` → 必填；无 `default` 且带 `'~optional': true` → 可选；其余 → 必填。三组都以 `StaticDefaulted<属性类型>` 递归，所以嵌套对象、数组元素、联合分支里的默认值同样生效。

其它形状（`Record`、`Tuple`、`Intersect`、`Ref`）不递归，落回 `Static<T>`：这些形状上的默认值不会被推成必填，是本设计接受的边界。

实测（`tsc --noEmit`）：省略有默认值的字段报错、只有 `Type.Optional` 的字段仍可选、嵌套对象与数组元素递归正确、`Static<T>` 不变。

### 在总线上换掉参数类型，而不是给每个工具加包装器

工具定义都经总线注册，`execute` 的参数类型由定义类型决定，所以只需改总线：

- 新增 `ToolDefinitionWithDefaults<TParams, TDetails>`（与 pi 的 `ToolDefinition` 同形，只把 `execute` 的参数换成 `StaticDefaulted<TParams>`），`register` 收它；
- `CodemodeToolDefinition` / `StructuredToolDefinition` 的 `execute` 参数同样换成 `StaticDefaulted<TParams>`。

工具作者不需要任何包装函数或 cast：写 `bus.registerCodemodeOnly({ ..., execute(_id, params) { ... } })` 时，`params.fail_fast` 直接是 `boolean`。运行时成立的理由是总线在调用 `execute` 前一定跑过 `Value.Default`。

兼容性：`StaticDefaulted<T>` 是 `Static<T>` 的子类型（默认值只把可选字段变成必填），所以仍按 pi 的 `ToolDefinition` 形状交给 `pi.registerTool`，既有按 `Static<TParams>` 标注 `execute` 的工具（含 `defineStructuredTool` 的产物）也照常可赋给新签名。

替代方案：给每个工具加 `defineDefaulted*` 包装器——每个带默认值的工具都要换写法，且多一层函数；改 pi 的 `ToolDefinition`——那是宿主类型，动不了。

### 默认值只有 schema 一处来源

总线补齐默认值之后，handler 里的 `?? DEFAULT_XXX` 全部是第二份来源，迁移时一并删除；`DEFAULT_XXX` 常量本身也删掉，默认值直接写在 `Default()` 的第二个参数上。之前这些常量存在的理由是「描述文本要插值」「读取层要兜底」——描述改由 schema 注解渲染，读取层的兜底改由 schema 推导的必填类型取代，两个理由都不再成立。

读取层（`src/lib/github.ts` / `github-reads.ts` / `web/search.ts`）与工具 schema 原本各写一份同名参数接口，`limit` 改成必填时要在两处同时改。现在共享参数 schema 下沉到 `src/lib`（`github-params.ts`、`web/search.ts` 的模块级 const），工具注册与读取层都从它推导类型，工具侧不再有第二份 interface。

### 约束交给 schema，声明渲染器负责让它可见

`minimum` / `maximum` / `minLength` 等边界只写在 schema 上：pi 侧随 JSON Schema 进上下文，codemode 侧由 `declarations.ts` 渲染成 `@minimum <n>` 等 JSDoc tag。此前渲染器只输出 `description` 与 `default`，作者只能把上限写进描述文本（再抽一个常量插值），于是同一个值在 schema 与文案里各出现一次；渲染器补上 tag 之后，`description` 只描述语义，边界不再重复。

`pattern` / `format` 仍不渲染：正则与格式串较长、且大多数工具用不到，继续由 `description` 文本承载。

## Risks / Trade-offs

- **有人写成 `Type.Boolean({ default: true })`，类型上看不见默认值** → 运行期仍然补值，但 handler 的类型会缺省成 `boolean | undefined`，退化成今天的写法（不会出错，只是没收益）。缓解：skill 文档明确写法；review 时 grep `default:` 出现在 `Type.*` options 里的情况。
- **`StaticDefaulted<T>` 与 TypeBox 的 `'~optional'` 标记耦合** → TypeBox 升级改标记名会静默失效（全部字段变必填，编译期立刻暴露）。缓解：`test/schema-defaults.test.ts` 用 `@ts-expect-error` 锁定行为。
- **类型断言依赖「总线必先补值」** → `execute` 的参数类型声明为 `StaticDefaulted`，而运行期补值来自 `parseToolArguments`。若有人绕过总线直接调用 `execute`（测试里常见），参数必须按补过默认值的形状传。缓解：只经总线调用；`test/schema-defaults.test.ts` 覆盖 `register` 与 `registerCodemodeOnly` 两条路径；`test/opencode-read.test.ts` 里直接调 `execute` 的用例显式传 `limit`。
- **总线的泛型变复杂** → `register` 收的是自定义的 `ToolDefinitionWithDefaults` 而不是 pi 的 `ToolDefinition`，但两者同形，只在内部转换一次。
- **上游恢复或新增官方机制（如重新提供 `Type.Options`，或 `Static` 的默认值推断）** → 本设计是自建 workaround，届时替换 `Default()` / `StaticDefaulted<T>` 即可；`#1581` 的追问若得到答复，按其结论更新。替换点集中在 `src/lib/schema-defaults.ts` 与 skill 文档。

## Migration Plan

1. 新增 `src/lib/schema-defaults.ts`（`Default` + `StaticDefaulted`）与类型/运行期测试。
2. 总线的 `register` / `registerCodemodeOnly` / `defineStructuredTool` 改用 `StaticDefaulted`。
3. 现有默认值迁到 `Default()`（wait 工具的 `fail_fast` 先行，其余工具随后），删除 handler 与读取层的 `??` 兜底和 `DEFAULT_XXX` 常量。
4. 共享参数 schema 下沉到 `src/lib`，读取层类型从 schema 推导。
5. codemode 声明渲染器输出约束 tag，schema 的 `description` 去掉重复的边界文案。
6. 更新 skill 文档。
7. 回滚：把总线参数类型改回 `Static<TParams>`、各默认值恢复 `?? 常量` 即可；schema 上的 `default` 仍被 `Value.Default` 使用，行为不变。
