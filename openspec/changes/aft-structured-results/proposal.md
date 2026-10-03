# AFT 感知工具的结构化结果

## Why

`aft_outline` / `aft_zoom` / `aft_callgraph` / `aft_search` 是 codemode 脚本里最常用的感知工具（脚本常要遍历大纲、命中列表、调用点），但它们今天只把引擎渲染的文本交给模型，脚本拿不到任何字段——要么正则解析文本，要么放弃脚本编排。

引擎本身**已经返回结构化数据**（我们只是把它渲染成文本后丢掉）：`outline` 的 files 模式带 `files[]` 条目，`zoom` 带 `name` / `range` / `content` / `annotations`，`callgraph` 各 op 带各自的列表与树，`search` 带 `results[]` 与解释后的查询。

## What Changes

- 四个感知工具改为 `defineStructuredTool`，在成功结果里带上 `structuredResult`。载荷 = **引擎响应原样字段**（去掉 envelope 的 request id）+ `text`（与工具输出一致的渲染文本），字段名与类型取自实测响应与 `@cortexkit/aft-bridge` 自己的格式化器。
- 全部引擎字段声明为可选且允许额外字段：引擎不归我们管，版本升级加字段/换名字不应该把工具调用变成失败。嵌套条目（调用点、命中）列出已知字段但一律可选——引擎自己对这些字段也做 `?? "(unknown)"` 兜底。
- 软失败（`symbol_not_found`、`callgraph_building`、`search_lanes_unavailable`）保持「工具跑成了」的语义：载荷保留引擎的 `success: false` 与 `code`，脚本据 `code` 分支；它们今天就是这样以文本返回的，不改。
- 工具输出文本、`details`、`pending` 等现有行为逐字不变。

## Impact

- 受影响 spec：`aft`（新增一条 requirement）。
- 受影响代码：`src/aft/schemas.ts`（新增，四个 schema）、`src/aft/tools.ts`（注册方式与结果载荷）、`test/aft-structured.test.ts` + `test/fixtures/aft/`（新增）。
- 不受影响：引擎交互、路径解析、等待窗口、注册门控、codemode 的可调用集合（四个工具本来就可调用）。

## Evidence

- 实测响应 fixture（真引擎，一个两函数小文件）：`test/fixtures/aft/outline-file.json`、`outline-files.json`、`zoom-greet.json`。
- callgraph / search 的合成 fixture：字段名取自 `@cortexkit/aft-bridge` 的 `callgraph-format` 与搜索渲染读哪些字段；未在真实项目上采集（需要在已 configure 的项目里建索引），因此不宣称字段完整。

## Out of Scope

- `outline` 的单文件模式没有结构化条目可给：引擎的符号树只用于渲染文本、不进响应。要做需要在引擎侧加结构化输出。
- 四个工具的注册门控与搜索的语义后端限制不在本次范围。
