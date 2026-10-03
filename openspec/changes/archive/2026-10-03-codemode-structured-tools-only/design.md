# 设计

## D1：为什么用「有没有结构化输出」当准入条件，而不是继续扩黑名单

`call()` 的返回值必须有确定的形状，否则脚本只能解析文本，声明里也写不出返回类型。这个要求与「工具能不能给脚本用」几乎重合：一个工具要么给了结构化结果（脚本可用），要么没有（脚本拿到的是给模型看的渲染文本）。把这条当准入条件，集合就由工具自己的声明推导出来，加工具的人顺手就决定了它进不进 codemode，不需要第二处判断。

代价是**默认不放行**：新工具的作者想让脚本能调用，就得给工具加 schema（本来就是本轮在做的事）。这比「默认放行、靠人记得加黑名单」安全——后者的失败模式是脚本悄悄拿到一段文本，前者的失败模式是脚本明确报「不可调用」。

## D2：`structuredSchema` 可选性收紧到必需

集合只收有 schema 的工具后，`CallableTool.structuredSchema` 与 `declarations.ts` 的 `ToolLike.structuredSchema` 都从可选变必需，`renderOverload` 里「没有 schema 就渲染 `Promise<string>`」的分支随之删掉——那是一段再也走不到的代码（工具没 schema 就不会被渲染）。声明里的 `declare function call(name: string, args?: unknown): Promise<unknown>` 动态名字兜底保留，它管的是「名字由变量决定」这类调用，不是「工具没有返回类型」。

## D3：失败路径不变

- 不在集合里的名字：`onCall` 在调用总线之前就拒绝，报 `Tool "<name>" is not available in codemode.`，工具不执行。
- 在集合里但运行时没给结构化结果：总线 `checkStructuredResult` 已经把它变成失败结果（`declared a structuredSchema but returned no structuredResult`），`onCall` 的文本回退分支据此返回 `CallFailedError`。两者都由脚本捕获，不需要新错误类型。
