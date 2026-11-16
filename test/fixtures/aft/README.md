# AFT 响应 fixture

字段名与形状以引擎源码为准：`/srv/ssd-1/projects/github/cortexkit/aft` 的 `v0.64.0`（与本仓库安装
的 `@cortexkit/aft-bridge` 版本一致）。关键位置：

- `crates/aft/src/protocol.rs`：`tool_call` 信封（`id` / `success` / `code` / `message`）。
- `crates/aft/src/commands/outline.rs`：四种请求模式各自的字段（单文件 / 目录 `files:true` /
  目录发现 / 多文件数组）。
- `crates/aft/src/commands/zoom.rs` + `subc_translate.rs`（`translate_zoom`）：`tool_call` 路径
  永远返回 `targets` 包装。
- `crates/aft/src/commands/callgraph_store_adapter.rs`：6 个 op 的响应结构体，含 golden JSON。
- `crates/aft/src/commands/semantic_search/mod.rs`：搜索顶层字段与两种命中条目。
- `crates/aft/src/list_envelope.rs`：`*_list_envelope`（截断/分页信封）。

这些 fixture 是按上述结构体**手工构造**的代表性响应，不是本机实测输出（实测需要在已 configure
的真实项目上跑引擎建索引，测试里不做）。它们的作用是固定「载荷 = 引擎已声明字段 + `text`」
这条契约：schema 只要与真实响应错位（少声明一个引擎字段、或多声明一个引擎不会给的字段），
对应断言就会红。

`crates/aft/tests/` 下有不少.json 是旧版本抓包或渲染器输入（例如 `fixtures/trace/*.json`
含 v0.64.0 已不产出的 `is_entry_point`、`flow_type: "origin"`），不要拿来当依据。
