### aft_outline tool

在读取具体内容之前先了解文件或目录的结构。

- target 为文件路径时：返回该文件的符号大纲，每个符号带签名与行号（如 `function greet(name: string): void 5:12`）；Markdown/HTML 返回标题层级。适合先定位符号名和位置，再决定是否用 aft_zoom 看实现。
- target 为目录路径时：默认返回扁平文件树（语言、顶层符号数、字节大小），一眼看清目录里有什么、规模多大；传 `files: false` 可切换为符号大纲（目录下每个文件的符号树，无签名，输出上限 30KB，超限截断）。
- `includeTests` 只在符号大纲模式（`files: false`）生效：为 true 时包含测试文件，默认排除。
- 目录递归上限 200 个文件；超出部分在结果中标记截断。
- 只接受单个 target，不支持数组；跨文件批量用多次调用。

分工：看结构用本工具；看某个符号的完整源码用 aft_zoom；看符号间调用关系用 aft_callgraph；按语义/文本搜代码用 aft_search。
