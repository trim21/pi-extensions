# 设计

## D1：位置用 1-based，不用 LSP 原始的 0-based

LSP 线上协议的行列是 0-based，仓库里其它面给模型/脚本的东西都是 1-based（这三个工具的文本 `path:line:col`、它们的 `line` / `character` 参数、AFT 的行号）。载荷给 0-based 会让脚本在「拿到位置」与「传回位置」之间做两次心算，且和它同时能看到的文本对不上。因此载荷在工具层显式 +1，schema 描述里写明 1-based。

代价是与 `InspectLocation`（服务层归一化后的 0-based）不逐字对应，读代码时要过一层 `toLocationPayload`。换来的是「载荷里的位置可以直接抄进另一次 lsp 调用或 `Read` 的 offset」这一条性质。

## D2：载荷给全部位置，文本该截就截

`lsp-find-reference` 的文本上限（每文件 10 条、最多 30 个文件）是为模型上下文设的。脚本读载荷不需要这个预算，所以载荷构造在截断逻辑之外（渲染函数管文本，`toLocationPayload` 管载荷），两者同源但不同限。这也让「文本里有截断标注」与「载荷里有全部位置」不矛盾：它们是同一份数据的两种呈现。

`truncated` 这类标志因此不需要：载荷永远完整，脚本不需要判断自己拿到的是不是全部。

## D3：hover 只带 `text` + `serverID`

`Hover.contents` 是异构联合（`string` / `{ language, value }` / 数组 / `MarkupContent`），把它原样放进 schema 会让载荷形状随服务器实现变化（不同语言服务器给不同种类），脚本反而难用。现有的渲染函数已经把这层差异消化成文本（MarkedString 数组转 code fence、MarkupContent 取 `value`），因此载荷给渲染后的 `text`，另加 `serverID` 说明是谁回答的。

`hover.range` 不放进载荷：它是 0-based 的原始 LSP Range，与 D1 的 1-based 口径混用会误导；真需要时单独决策。

## D4：载荷怎么穿过消歧探测

工具用 `probeSymbolCandidates` 对行内每个同名候选各探测一次，再按渲染文本分组挑出一组。载荷必须跟着**被选中的那一组**走，因此 `InspectOutput` 变成泛型：`{ text, subtitle, payload }`，渲染函数只产出 `{ text, subtitle }`，probe 把 `payload` 拼上去。分组逻辑按 `text` 走（不变），返回时连同该组的 payload 一起返回——这样「报歧义」与「选中某一组」两条路径都不会给出错位的载荷。
