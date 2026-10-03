# LSP 查询工具的结构化结果

## Why

三个只读 LSP 查询工具（`lsp-find-definition` / `lsp-find-reference` / `lsp-inspect`）的返回值本来就是结构化的数据（服务层已把 Location / LocationLink 归一化成位置列表，hover 是服务器的原始内容），只是渲染成了文本给模型。脚本要用这些位置只能解析 `path:line:col` 文本。

按 codemode 的新准入条件（声明了 `structuredSchema` 才进可调用集合），没有结构化输出的工具不进脚本，所以这三个工具要进 codemode 就得先给载荷。

## What Changes

- **三个工具改用 `defineStructuredTool`**，成功结果带 `structuredResult`：
  - `lsp-find-definition` / `lsp-find-reference`：`{ text, serverID, locations: [{ path, line, character }] }`
  - `lsp-inspect`：`{ text, serverID }`
- **位置是 1-based 的绝对路径**：与工具文本里的 `path:line:col` 同一套口径（也对齐这三个工具自己的 `line` / `character` 参数），脚本拿到就能回喂给下一次查询。行/列在这里显式 +1，因为 LSP 线上协议是 0-based，而面给脚本的一律是 1-based。
- **`locations` 给全部位置**：`lsp-find-reference` 的文本会按上限截断（每文件 10 条、最多 30 个文件），载荷不跟着截——载荷是给程序用的数据，截断是渲染给模型看的事。与 `Bash` 的载荷给完整输出同一个取向。
- **`serverID` 随结果给出**：多个语言服务器配置下，脚本能知道这次是谁回答的。
- 文本输出、`details.pendant`、错误抛出行为都不变；`lsp-rename`（写工具）不在本次范围，它没有结构化输出，因此按准入条件不进 codemode。

## Impact

- `src/lib/lsp/inspect-tool.ts`：`InspectOutput` 加载荷字段（泛型），三个工具改 `defineStructuredTool`。
- 新增 `src/lib/lsp/inspect-schemas.ts`。
- 新增 `test/lsp-inspect-structured.test.ts`（fake service + 真实 ToolBus，覆盖 1-based 位置、载荷不截断、hover 载荷、无 hover）；`test/lsp-e2e-inspect.test.ts` 补载荷断言（真实 tsserver）。
- codemode 的可调用集合随之多出这三个工具（描述里的声明块 +3）。

## Out of Scope

- `lsp-rename` 的结构化结果与是否进 codemode。
- hover 内容的重新建模（`contents` 是 `string | MarkedString | MarkedString[] | MarkupContent` 的异构联合，载荷仍给渲染后的文本，避免把服务器的格式判断搬进 schema）。
- `hover.range`（原始 LSP Range 是 0-based，与载荷的 1-based 口径混用会误导；需要时另开）。
