# AFT 响应 fixture

- `outline-file.json`、`outline-files.json`、`zoom-greet.json`：对真引擎（`@cortexkit/aft-linux-x64`）
  实测响应的原样保存（一个两函数、六行的小文件），用来固定我们依赖的字段。
- `callgraph-*.json`、`search-hybrid.json`：**合成**响应，字段名取自 `@cortexkit/aft-bridge`
  自己的格式化器读哪些字段（callgraph-format.js / 搜索渲染），不是实测输出——实测需要在
  一个已 configure 的真实项目上跑引擎建索引，测试里不做。因此这些 fixture 只用来验证
  「引擎字段原样进入载荷」，不宣称字段的完整性。
