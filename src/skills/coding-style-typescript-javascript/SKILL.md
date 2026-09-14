---
name: coding-style-typescript-javascript
description: Use when 编写、生成、修改、编辑、重构或评审任何 TypeScript / JavaScript 代码——涵盖实现功能、修 bug、写脚本、写测试、性能优化、代码迁移、重命名、加减参数或函数、修改函数签名、定义类型、interface、处理函数间数据流、JSON 反序列化、zod、typebox、tsconfig、code review / PR review。任何会产出或改动 TS/JS 代码的任务（write / edit / refactor / review TypeScript or JavaScript code）都要先加载本 skill，即使用户没有提到风格、规范或最佳实践。只读调查不加载：单纯 debug、定位代码、定位问题、读代码理解逻辑等不改代码的任务不需要加载。
---

# TypeScript / JavaScript 编码风格

**REQUIRED BACKGROUND：先加载 `coding-style`（shared）**——语言无关的原则与"为什么"在那里，章节序号与本文件对应。本文以 TypeScript 为准；纯 JavaScript 没有类型标注，只有"边界校验 + JSDoc 标注"一条弱化路径可选。

---

## 1. 函数边界容器

- **不用 `any`、`{}`、`object` 做函数参数/返回值。** `any` 等于 `Any`；`{}` / `object` 是"任何非 null 值"，和裸字典一样零信息。
- **结构化数据用 `interface` / `type`**，字段带类型。不在 Go 里写成 `map[K, V]` 的场景，TS 里也不用 `Record<string, X>` 硬凑。
- **边界收 `unknown`，不用 `any`。** `JSON.parse` 返回值天然是 `any`，拿到后第一时间显式标注为 `unknown`，再走边界校验。
- **多参数函数用参数对象。** 参数 ≥ 3 个、或含同类型参数（如 `x: number, y: number`）时，收一个参数对象 `opts: PositionOpts`，字段名显式出现在调用点——对应 Python 的 `kw_only` 原则。TS 按位置传参比 Python 更常见，同类型字段传反了类型检查发现不了。
- **不可变（对应 Python `frozen`）：** 数据对象字段用 `readonly`，集合用 `ReadonlyArray<T>` / `ReadonlyMap` / `ReadonlySet`；"更新状态 = 产出新对象"用对象展开 `{ ...obj, field: v }`。注意 `readonly` 是浅层的，嵌套容器字段同样要 readonly。
- **取值集合用字面量联合类型或枚举**，不用魔法字符串：`type Side = "buy" | "sell"`。非法值在调用点就是类型错误。
- **开启 `strict: true` 与 `noUncheckedIndexedAccess`**（tsconfig），后者让 `obj[key]` 返回 `T | undefined`，把"键不存在"从静默 undefined 变成必须处理。

## 2. 边界校验 + 反序列化分两层

TS 生态里 zod 与 typebox 是两个主流校验库：zod 更常用、类型推断顺手；typebox 产物即 JSON Schema、适合需要 schema 跨语言共享或性能敏感的场景。二选一跟项目走，同一项目不混用。

两层结构与 `coding-style` 第 3 节一致：第 1 层是校验库的原始 schema（1:1 对应外部形状，只做形状 + 基础类型校验）；第 2 层是手写的 readonly 内部模型，转换函数从 raw 到 internal，类型安全。

### 用 zod

```ts
import { z } from "zod";
import { readFileSync } from "node:fs";

// — 第 1 层：原始 schema，1:1 对应配置文件形状 —
const RawStrategyConfigSchema = z.object({
  lookback: z.number().int(),
  threshold: z.number().positive(),
  symbols: z.array(z.string()),
  // 新加字段：optional/default 表达"外部可以没有"，兼容旧配置文件
  venue: z.string().nullish(),
  feeBps: z.number().default(0),
});

type RawStrategyConfig = z.infer<typeof RawStrategyConfigSchema>;

function loadRawConfig(path: string): RawStrategyConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  return RawStrategyConfigSchema.parse(raw); // 非法即抛 ZodError，不让坏数据进入内部
}

// — 第 2 层：内部模型，转换得到 —
interface StrategyConfig {
  readonly lookback: number;
  readonly threshold: number;
  readonly symbols: readonly string[];
  readonly venue: string; // 内部不接受 null/undefined，转换时给默认/报错
  readonly feeRate: number; // 派生字段：bps → 比率
}

function toInternal(raw: RawStrategyConfig): StrategyConfig {
  return {
    lookback: raw.lookback,
    threshold: raw.threshold,
    symbols: [...raw.symbols],
    venue: raw.venue ?? "default_venue",
    feeRate: raw.feeBps / 1e4,
  };
}

export function loadConfig(path: string): StrategyConfig {
  return toInternal(loadRawConfig(path));
}
```

要点：

- **`z.infer` 让 schema 是类型的唯一来源。** 原始 schema 的 TS 类型从 schema 推导，不要手写一份平行的 `interface` 再让两者漂移。
- **内部模型手写成 readonly interface**，而不是把 zod 推导类型一路传下去——内部不接受 `null | undefined`、要 readonly 时，正是转换层存在的意义（`coding-style` 第 3 节"转换层解耦"）。
- **模块级复用同一个 schema 对象**；`parse` 抛错即边界拒绝，内部不需要再校验。
- **键名映射在 schema 层解决**（上游键名与内部命名不一致时用 `.transform()` 等 schema 能力），不要在转换函数里用字符串索引 raw。

### 用 typebox

```ts
import { Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFileSync } from "node:fs";

const RawStrategyConfigSchema = Type.Object({
  lookback: Type.Integer(),
  threshold: Type.Number(),
  symbols: Type.Array(Type.String()),
  venue: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  feeBps: Type.Number({ default: 0 }),
});

type RawStrategyConfig = Static<typeof RawStrategyConfigSchema>;

function loadRawConfig(path: string): RawStrategyConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  // Value.Parse 校验失败时抛错；也可以用 Value.Check 先判，自行报错
  return Value.Parse(RawStrategyConfigSchema, raw);
}
```

`toInternal` 与 zod 版完全相同——这正是两层设计的价值：校验库换了，内部模型和转换层不动。

要点：

- `Static` 是 typebox 的类型来源，同 `z.infer` 的角色。
- TypeBox 的 `default` 值要经过 `Value.Parse`（或带 default 的 decode 管线）才会补上，不是 TypeScript 类型层行为。
- 需要给非 TS 消费方共享 schema 时，typebox 产物即 JSON Schema，这是选它而非 zod 的主要理由。

### schema 归谁控制与未知键

与 `coding-style` 第 3 节同规则，落到 zod/typebox 上：

- **我们控制的 schema（配置文件）：** 支持的项全部声明；新加可缺省项用 `.optional()` / `.default()`（zod）或 `Type.Optional`（typebox），旧文件继续可解析。
- **上游控制的 schema（API 响应、消息）：** 只声明代码真正读取的字段。zod 默认剥离未知键（strip）；TypeBox 不声明 `additionalProperties` 即不校验未知键——都不要配成"未知键报错"，理由见 `coding-style` 第 3 节。
- **可选语义 = 有默认值。** 新增字段必须 optional/default，否则旧数据缺键直接 parse 抛错，破坏向后兼容。

## 3. 类型检查配置

tsconfig 最低要求：

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

- `strict: true` 关掉隐式 any 与一系列松散检查，是第 1 节一切规则的前提（对应 Python 侧的 `disallow_untyped_defs`）。
- `noUncheckedIndexedAccess` 让字典/数组索引访问必须判 undefined，配合"裸字典只用于 `map[K, V]` 语义"。
- `exactOptionalPropertyTypes` 区分"没有这个键"和"键的值是 undefined"，与两层 schema 的"缺键走默认值"语义对齐。
