### aft_callgraph tool

基于真实调用图回答代码关系问题（谁调用我、影响面、调用链），替代 grep + read 的链条式排查。

op 选择：

- `callers`：谁调用了目标符号。改名/改签名前先查调用点。含测试文件用 `includeTests: true`。
- `impact`：改动一个符号会波及谁（影响面分析）。与 callers 配合评估重构风险。
- `call_tree`：目标符号调用了什么（展开调用链）。
- `trace_to`：从某个入口函数如何执行到目标符号（调用链路径）。
- `trace_to_symbol`：两个符号之间的最短路径。需要 `toSymbol`；同名符号歧义时用 `toPath` 指定目标文件。
- `trace_data`：追踪某个值在参数/赋值间的流转。需要 `expression`（如参数名、变量名）。

参数：`path`（包含目标符号的文件）+ `symbol` 必填；`depth` 限制遍历深度。

标记含义：`~` = 仅按名字解析的边（可能指向同名符号）；`[unresolved]` = 未解析到定义的调用点（外部库/stdlib 默认折叠为每父节点一条摘要，`includeUnresolved: true` 逐个列出）。

符号未定义时返回文本说明，不报错。

索引正在重建时，本工具会等待其就绪再返回结果；若返回 `callgraph_building`，稍后重试同一查询即可。
