# codemode-kv-store-api

## Why

codemode 脚本侧的持久化接口现在是 `store(key, value)` / `load(key)`：能写能读，但**无法枚举**。store 跨调用（甚至跨 resume）保留，上下文压缩之后模型已经记不得自己写过哪些 key，只能靠猜——猜不中就永远读不回自己存过的东西。补一个 `list()` 就够了。

命名上改为 KV 风格 `set` / `get` / `list`：与实现（键值表）一致，三个动词各自职责单一。

## What Changes

- 脚本侧的 `store(key, value)` 改名为 `set(key, value)`，`load(key)` 改名为 `get(key)`；语义不变（`set(key, undefined)` 删除该键、`get` 未命中返回 `undefined`）。
- 新增 `list(): string[]`：返回当前 store 的键（升序）。
- 容量上限、`details.store` 持久化与重放机制、失败脚本不写入等行为全部不变。

## Impact

- `src/codemode/prelude.ts`（脚本侧接口）、`src/codemode/declarations.ts`（TS 声明）、`src/codemode/tool.ts`（工具描述里的用法说明）。
- `test/codemode.test.ts`、`test/codemode-tool.test.ts` 的脚本样例随之改名，并补 `list()` 用例。
- README、`openspec/specs/codemode/spec.md` 同步。
- 没有兼容负担：codemode 尚未在别处被使用，旧名直接替换，不留别名。
