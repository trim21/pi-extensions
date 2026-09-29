# Design

## Context

动机见 proposal.md。实现前的事实（行号取自本次改动前）：

`src/lib/lsp/lsp.ts`：

- `configDefaults`（`lsp.ts:107`）：`{ watch: { enabled, debounceMs, flushMs, maxBatch }, maxOpenDocuments: clientDefaults.maxOpenDocuments }`，`as const`；文档注释称「超时/LRU 与 client.create 共用 clientDefaults；watch 无 client 对应项，数值在此集中」。
- 引用点：`resolveConfig` 的 4 行 watch 缺省（`lsp.ts:195-198`）与 `maxOpenDocuments`（`lsp.ts:200`），以及字段级注释里提到 `configDefaults` 的两处（`lsp.ts:81`、`lsp.ts:89`——后者已在本轮上一步改为指向 `clientDefaults`）。
- `clientDefaults`（`client.ts:266`）是 7 个客户端参数值的唯一来源，`as const`；`LspClientOptions`（`client.ts:290`）是字段集合的唯一声明。

`test/lsp-config.test.ts`：

- describe `mergeConfig + resolveConfig` 有 8 处 `toMatchInlineSnapshot`，每处都钉住完整的 `ResolvedLspConfig`（含 7 个客户端字段）：`L63`（配 `diagnosticsDebounceMs: "5s"` + `initializeTimeoutMs: 10_000`）、`L95`（配 `diagnosticsDocumentWaitTimeoutMs: 3_000`，本地覆盖 `initializeTimeoutMs: 10_000`）、`L136`、`L187`、`L218`、`L253`（以上 4 处全缺省）、`L296`（配 `maxOpenDocuments: 8`）、`L342`（全缺省）。
- 文件头注释（`L1-8`）描述该 describe 的覆盖面。
- 测试文件目前未 import `clientDefaults`。

## Goals / Non-Goals

**Goals:**

- 客户端参数的缺省**值**只在测试里出现一次。
- 服务层（`servers` / `enabled` / `disabled` / `watch`）的快照不再随客户端参数的增减而变动。
- `resolveConfig` 里 7 行客户端参数写法一致（都从 `clientDefaults` 取缺省，无中间别名）。

**Non-Goals:**

- 不合并 `lspConfigSchema` 与 `resolveConfig`（上一轮已评估：需要 mapped type 断言 + 两处窄 cast，且会把 lsp.json 的字段文档挪出配置层）。
- 不改 `clientDefaults` 的值、不增删字段。
- 不动 `src/skills/lsp-config/SKILL.md` 里的散文缺省值列表（面向读该 skill 的模型，独立于代码结构）。
- 不改测试的断言强度：客户端参数的键集合与取值仍被逐一比对。

## Decisions

### D1 拆服务层 / 客户端参数，而不是删快照

`splitResolved` 用 rest 解构把两者分开，四个服务层绑定全部被使用（放进返回对象），因此不触发 `@typescript-eslint/no-unused-vars`（该规则未开 `ignoreRestSiblings`，`varsIgnorePattern` 只匹配精确的 `_`）：

```ts
/**
 * 拆开解析结果：服务层字段（servers / enabled / disabled / watch）用快照断言，
 * 客户端参数单独断言——新增旋钮只需改「客户端参数缺省值」用例，不必改下面每处快照。
 */
function splitResolved(config: ResolvedLspConfig) {
  const { servers, enabled, disabled, watch, ...client } = config;
  return { service: { servers, enabled, disabled, watch }, client };
}
```

- 备选一：把快照里的 7 行客户端字段删掉、只留服务层字段——那会让 `toMatchInlineSnapshot` 少断言 7 个字段而没有任何替代断言，覆盖下降。否决。
- 备选二：改成 `toMatchObject` 只断言配置过的那一个旋钮——会丢掉「未配置的旋钮取缺省」这一断言（即 `resolveConfig` 漏应用缺省也测不出来）。否决。

### D2 客户端参数断言用 `{ ...clientDefaults, 覆盖值 }`

```ts
expect(client).toEqual({
  ...clientDefaults,
  diagnosticsDebounceMs: 5_000,
  initializeTimeoutMs: 10_000,
});
expect(client).toEqual(clientDefaults); // 未配置任何客户端参数的用例
```

`toEqual` 对普通对象按「键集合 + 取值」严格比对（不忽略 undefined 值的键差异），因此这个断言同时覆盖：字段齐全、未配置项取缺省、配置项取解析后的值（含字符串时长换算）。展开 `clientDefaults` 让新增旋钮自动进入期望值，无需改这些行。

### D3 缺省值在唯一一处钉住

新增一个用例把 `clientDefaults` 整体快照一次：

```ts
it("客户端参数缺省值集中在 clientDefaults", () => {
  expect(clientDefaults).toMatchInlineSnapshot(`...`);
});
```

- 为什么保留这个快照：D2 的 `toEqual(clientDefaults)` 是「解析结果 = 缺省来源」的自洽断言，若有人改掉 `clientDefaults` 的值，缺省值本身没有任何测试会失败（只有文档会与代码不一致）。这一处快照把 7 个数值固定，改值必须是一次显式修改。
- 代价：新增一个旋钮仍需在此处加 1 行——从 8 处降到 1 处，这是可以接受的下限。

### D4 `watchDefaults` 去掉包装层而不是改名保留

删掉 `maxOpenDocuments` 转发后 `configDefaults` 只剩 `watch` 一个键，`configDefaults.watch.x` 比 `watchDefaults.x` 多一层无意义的间接。直接把它变成 watch 段自身的值对象，文档注释写明「客户端参数缺省见 clientDefaults」。

## Risks / Trade-offs

- [D2 的断言从「内联字面量快照」变成「与 `clientDefaults` 比较」，若有人把 `clientDefaults` 与 `resolveConfig` 同时改错成同一个错误值，测试不会失败] → D3 的快照固定了缺省值本身，两者必须同时被改错且方向一致才能漏过；这是把 8 处冗余快照换成 1 处快照所付出的代价，已评估为可接受。
- [拆分后 `service` 快照不再展示客户端参数，读者要跳到 `clientDefaults` 才能看到缺省值] → `splitResolved` 的注释与 D3 的用例名都指向 `clientDefaults`。
- [`watchDefaults` 的改名会碰 `resolveConfig` 的 4 行与 2 处文档注释] → 纯机械改名，`tsc` 会抓漏。
- 无行为变化，无迁移与回滚需求。
