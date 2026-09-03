### aft_zoom tool

查看命名符号（函数/类/类型）的完整源码，或 Markdown/HTML 文档的标题段落内容。

- `path` 必填：文件路径（绝对或相对项目根）。
- `symbols`：要查看的符号名；字符串或数组（同文件多个符号一次查询）。代码文件按符号名精确解析；Markdown/HTML 按标题文本匹配（可含空格，用完整标题字符串）。
- `contextLines`：符号前后附加的上下文行数，默认 3。
- `callgraph: true`：附带同文件内 calls-out / called-by 调用关系标注，帮助理解符号如何被使用、依赖谁。
- 适合先 aft_outline 拿到符号名与行号，再 zoom 具体实现；不要用它读整个文件（用 read）。
