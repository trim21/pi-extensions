# 设计

## D1：载荷 = 引擎响应原样字段 + `text`

引擎响应已经是我们需要的全部结构化数据，再设计一套「归一化形状」只会引入一层需要跟着引擎改的映射，还会丢掉脚本可能用得上的字段（`resolved_by`、`hub_summary`、`snippet`、`score`…）。因此载荷直接透传引擎字段，另加一个 `text`（我们渲染的那份，与工具输出一致）作为人类可读的兜底。

去掉的只有 envelope 的 `id`（传输层的东西，对脚本无意义）。`success` / `code` 保留：软失败是「工具跑成了、引擎给出否定答案」，脚本据 `code` 分支（与 Bash 用 `exitCode` 分支同一个思路）。

## D2：schema 一律宽松（可选 + 允许额外字段）

引擎是外部依赖，它的响应会加字段、改字段名、在预算耗尽时省略字段（例如 `symbols` 只在已知时出现）。声明成必需会让引擎的一次小版本升级把工具调用变成失败——`structuredResult` 过不去总线的 `Value.Parse` 就是失败结果。

所以：顶层与嵌套字段全部可选、`additionalProperties: true`。「宽松」不等于不校验——**类型**仍被复核（`text` 必需，列出的字段类型必须对得上），只是不因为字段增减而失败。

代价：脚本侧声明里 `?` 很多，模型不能假设字段一定在场。这正是引擎的真实情况（它的格式化器对每个字段都做 `?? "(unknown)"`），如实反映比给一个会骗人的精确类型好。

## D3：每个工具一份 schema，callgraph 合并 6 个 op

`aft_outline` / `aft_zoom` / `aft_search` 各一份 schema。`aft_callgraph` 一个工具名下 6 个 op、6 种响应形状（分组调用点 / 树 / 扁平影响面 / 路径列表 / 单条路径 / 数据流跳），合成一份把所有 op 的锚点与列表列为可选的 schema：

- 声明成 `anyOf` 的 6 个分支会让 codemode 的返回类型说明膨胀到难以阅读（每个分支都要内联完整字段），而脚本侧本来就要按自己传入的 `op` 解释结果。
- 6 个 op 的字段名有重叠（`symbol` / `file` / `line` / `callers` / `paths` / `hops`），合并后每个名字只出现一次。
- 递归的 `call_tree.children` 用 `unknown[]` 声明：TypeBox 的递归 schema 在 `renderType` 里没有对应渲染，而树本身完整地在载荷里。

## D4：fixture 分两类，不混称

- 真引擎实测的响应（outline 两种模式 + zoom）原样存进 `test/fixtures/aft/`，测试据此断言字段。
- callgraph / search 用合成 fixture（字段名取自 `@cortexkit/aft-bridge` 的格式化器），`README.md` 里明确标注，不宣称实测。

实测需要在真实项目上跑引擎建索引（`configure` 之后才能查调用图与搜索），测试里不做；需要时由使用者在自己的项目里采一份替换进去。
