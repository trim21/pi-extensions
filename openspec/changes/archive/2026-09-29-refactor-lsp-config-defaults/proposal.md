# Proposal

## Why

上一轮把 LSP 客户端参数收敛到 `LspClientOptions` 后，新增一个旋钮仍需手改 4 处（`clientDefaults`、`lspConfigSchema`、`resolveConfig`，以及 `test/lsp-config.test.ts` 的 8 处内联快照）。其中两处是可以消除的：

- `src/lib/lsp/lsp.ts:107-114` 的 `configDefaults` 装着一组真缺省（`watch` 的 4 个值）外加一个纯转发 `maxOpenDocuments: clientDefaults.maxOpenDocuments`：同一个数字被起了第二个名字，`resolveConfig` 里 7 行客户端参数中有 1 行与另外 6 行写法不一致（走别名而非 `clientDefaults` 直取）。`8f8dd55` 给 `lsp-config.test.ts` 加了 8 行，正是那 8 处内联快照各自钉住了完整的 7 个客户端字段——加一个旋钮要改 8 个地方，而这些快照真正想断言的是服务层（`servers` / `enabled` / `disabled` / `watch`）的合并与解析行为。

- 客户端参数的缺省**值**没有任何单一快照钉住，它们的值散落在 8 处完整对象快照里重复出现。

## What Changes

- `src/lib/lsp/lsp.ts`：删除 `configDefaults` 的 `maxOpenDocuments` 转发，`resolveConfig` 与其余 6 行一致地读 `clientDefaults.maxOpenDocuments`；`configDefaults` 只剩 `watch` 一组值，因此去掉那层包装并改名 `watchDefaults`，同步更新引用它的文档注释。
- `test/lsp-config.test.ts`：新增 `splitResolved(config)` 测试辅助，把 `resolveConfig` 的结果拆成服务层字段与客户端参数；8 处内联快照只保留服务层字段，客户端参数改为 `toEqual(clientDefaults)` 或 `toEqual({ ...clientDefaults, <被配置的旋钮>: <期望值> })`；新增一个用例把 `clientDefaults` 的 7 个缺省值钉成**唯一一处**快照。
- 效果：新增/修改旋钮时该测试文件只需改 1 处（缺省值快照），而不是 8 处；服务层快照不再随客户端参数的增减而变动。
- 不改变任何对外行为：`lsp.json` 字段名、缺省值、解析结果（`ResolvedLspConfig` 的键与层级）全部不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无。纯结构重构与测试重构，行为契约不变，因此 `.openspec.yaml` 标记 `skip_specs: true`。）

## Impact

- 代码：`src/lib/lsp/lsp.ts`（删 3 行、改 5 行引用）。
- 测试：`test/lsp-config.test.ts`（8 处快照拆分 + 1 个新用例）。断言强度不降：客户端参数由「完整对象快照」改为「与 `clientDefaults` 逐键相等」，键集合与取值仍然被逐一比对，且新增的缺省值快照把 7 个数值固定在唯一一处。
- 不涉及配置格式、公开 API、依赖或 spec 行为；`resolveConfig` 的输出形状不变，`test/lsp-e2e-*` 等依赖 `maxOpenDocuments` 走配置注入的端到端用例不受影响。
