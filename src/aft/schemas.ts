/**
 * AFT 感知工具的结构化结果 schema。
 *
 * 载荷就是引擎自己的响应字段（去掉 envelope 的 request id），外加一个 `text`——我们自己
 * 渲染（或引擎渲染）的文本，与工具输出一致。字段名与类型来自三处证据：
 *
 * - 本仓库对真引擎的实测响应（outline 两种模式、zoom，见 `test/fixtures/aft/`）；
 * - `@cortexkit/aft-bridge` 自己的格式化器读哪些字段（callgraph 各 op、zoom 的注解）；
 * - 引擎的 `ListEnvelope` / 截断字段（walk_truncated、collection_truncated、truncated）。
 *
 * 两条刻意的宽松：
 *
 * 1. 所有引擎字段都是可选、且允许额外字段（`additionalProperties: true`）。引擎不归我们
 *    管，它的响应会加字段、换字段名；声明成必需会让版本一升级就把工具调用变成失败。
 * 2. 嵌套条目（callgraph 的调用点、搜索命中等）把已知字段列全但全部可选——引擎自己也用
 *    `?? "(unknown)"` 兜底，说明这些字段并非永远在场。
 *
 * 载荷只经总线 `Value.Parse` 复核一次（见 `src/lib/tool-bus.ts`），因此「宽松」不等于
 * 不校验：`text` 必需，列出的字段类型必须对得上。
 */

import { Type } from "typebox";

/** 引擎渲染的文本，与工具输出一致。 */
const text = Type.String({ description: "引擎渲染的文本，与工具输出一致" });

/** 行号区间（zoom）：引擎的 Range 序列化时行号从 1 开始。 */
const rangeSchema = Type.Object(
  {
    start_line: Type.Number(),
    end_line: Type.Number(),
    start_col: Type.Optional(Type.Number()),
    end_col: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

/** 调用图注解里的一条引用（zoom 的 calls_out / called_by）。 */
const callRefSchema = Type.Object(
  {
    name: Type.String(),
    line: Type.Number(),
    /** 同一行上还有多少条同类引用被折叠。 */
    extra_count: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

/** `aft_outline`：单文件模式只有 text（引擎不返回符号树），files 模式带文件条目。 */
export const aftOutlineStructuredSchema = Type.Object(
  {
    text,
    /** 引擎是否确定给全了结果。 */
    complete: Type.Optional(Type.Boolean()),
    /** files 模式（目录 + files: true）的文件条目。 */
    files: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String(),
            language: Type.String(),
            /** 顶层符号数；未知时引擎省略该字段。 */
            symbols: Type.Optional(Type.Number()),
            /** 行数；null 表示不在索引里（line_count_gaps 列出这些文件）。 */
            lines: Type.Union([Type.Number(), Type.Null()]),
          },
          { additionalProperties: true },
        ),
      ),
    ),
    /** 目录遍历触到上限。 */
    walk_truncated: Type.Optional(Type.Boolean()),
    /** 条目收集触到上限。 */
    collection_truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

/** `aft_zoom`：单符号源码 + 行号区间 + 同文件调用注解。 */
export const aftZoomStructuredSchema = Type.Object(
  {
    text,
    /** 符号名；行范围模式是 "lines X-Y"，符号歧义时缺省。 */
    name: Type.Optional(Type.String()),
    /** function / class / method / lines / ambiguous_symbol … */
    kind: Type.Optional(Type.String()),
    range: Type.Optional(rangeSchema),
    /** 符号源码（不含上下文行）。 */
    content: Type.Optional(Type.String()),
    context_before: Type.Optional(Type.Array(Type.String())),
    context_after: Type.Optional(Type.Array(Type.String())),
    annotations: Type.Optional(
      Type.Object(
        {
          calls_out: Type.Optional(Type.Array(callRefSchema)),
          called_by: Type.Optional(Type.Array(callRefSchema)),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

/** 调用图上的一条位置（callers 的调用点、impact 的受害点）。 */
const callgraphSiteSchema = Type.Object(
  {
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    /** callers 分组的调用符号名。 */
    symbol: Type.Optional(Type.String()),
    /** impact 的调用点符号名（与 caller_file 成对）。 */
    caller_symbol: Type.Optional(Type.String()),
    caller_file: Type.Optional(Type.String()),
    /** impact：该调用点自身是入口（脚本常据此过滤）。 */
    is_entry_point: Type.Optional(Type.Boolean()),
    /** 仅按名字解析出来的边（可能指向同名符号）。 */
    approximate: Type.Optional(Type.Boolean()),
    /** "name_match" 等解析来源。 */
    resolved_by: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** 调用链上的一跳（trace_to / trace_to_symbol）。 */
const callgraphHopSchema = Type.Object(
  {
    symbol: Type.Optional(Type.String()),
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    is_entry_point: Type.Optional(Type.Boolean()),
    /** trace_data：该跳流转的变量名与流向。 */
    variable: Type.Optional(Type.String()),
    flow_type: Type.Optional(Type.String()),
    approximate: Type.Optional(Type.Boolean()),
    resolved_by: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/**
 * `aft_callgraph`：一个工具名下 6 个 op，响应形状各不同（callers 是分组列表、call_tree 是
 * 树、impact 是扁平调用点、trace_to 是路径列表、trace_to_symbol 是单条路径、trace_data 是
 * 数据流跳）。这里把各 op 的锚点与列表都列为可选字段，脚本按 op 取用。
 */
export const aftCallgraphStructuredSchema = Type.Object(
  {
    text,
    /** 被查询的符号（callers / impact 的锚点）。 */
    symbol: Type.Optional(Type.String()),
    file: Type.Optional(Type.String()),
    /** call_tree 根节点的锚点。 */
    name: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    signature: Type.Optional(Type.String()),
    /** callers：按文件分组的调用点。 */
    callers: Type.Optional(
      Type.Array(
        Type.Object(
          {
            file: Type.Optional(Type.String()),
            callers: Type.Optional(Type.Array(callgraphSiteSchema)),
          },
          { additionalProperties: true },
        ),
      ),
    ),
    /** call_tree 根节点的直接子节点（整棵树在 payload 里，这里只标出形状）。 */
    children: Type.Optional(Type.Array(Type.Unknown())),
    /** call_tree 节点是否解析到定义；false 且无子节点 = 未解析的叶子。 */
    resolved: Type.Optional(Type.Boolean()),
    total_callers: Type.Optional(Type.Number()),
    total_affected: Type.Optional(Type.Number()),
    affected_files: Type.Optional(Type.Number()),
    /** impact 的参数表（改签名时要知道）。 */
    parameters: Type.Optional(Type.Array(Type.String())),
    /** trace_to：到目标符号的路径，每条路径是一串跳。 */
    paths: Type.Optional(
      Type.Array(
        Type.Object(
          { hops: Type.Optional(Type.Array(callgraphHopSchema)) },
          { additionalProperties: true },
        ),
      ),
    ),
    total_paths: Type.Optional(Type.Number()),
    /** trace_to_symbol：单条最短路径（没有路径时为 null）。 */
    path: Type.Optional(Type.Union([Type.Array(callgraphHopSchema), Type.Null()])),
    /** trace_data：值在赋值/参数/返回间的流转。 */
    hops: Type.Optional(Type.Array(callgraphHopSchema)),
    depth_limited: Type.Optional(Type.Boolean()),
    /** 因结果上限被折叠的条目数（引擎给的是数字，不是布尔）。 */
    truncated: Type.Optional(Type.Number()),
    /** 软失败（symbol_not_found / callgraph_building …）的错误码。 */
    code: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** 搜索命中：常规 ranking 条目（symbol）与降级时的 grep 行共用一份宽条目。 */
const searchHitSchema = Type.Object(
  {
    file: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    kind: Type.Optional(Type.String()),
    start_line: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    end_line: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    /** "matching line" / "line range" / "[file summary]" / "GrepLine"。 */
    location: Type.Optional(Type.String()),
    score: Type.Optional(Type.Number()),
    source: Type.Optional(Type.String()),
    semantic_score: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    lexical_score: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    exact: Type.Optional(Type.Boolean()),
    snippet: Type.Optional(Type.String()),
    /** grep 行条目：行号、列号与命中文本。 */
    line: Type.Optional(Type.Number()),
    column: Type.Optional(Type.Number()),
    line_text: Type.Optional(Type.String()),
    match_text: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** `aft_search`：查询解释 + 命中列表 + 截断/降级状态。 */
export const aftSearchStructuredSchema = Type.Object(
  {
    text,
    query: Type.Optional(Type.String()),
    /** 引擎对查询的最终解释（regex / literal / semantic / hybrid）。 */
    interpreted_as: Type.Optional(Type.String()),
    result_count: Type.Optional(Type.Number()),
    complete: Type.Optional(Type.Boolean()),
    /** 还有更多命中没给（与分页上限的区别由引擎的 envelope 说明）。 */
    more_available: Type.Optional(Type.Boolean()),
    engine_capped: Type.Optional(Type.Boolean()),
    /** 语义索引状态：ready / building / disabled / unavailable / external。 */
    semantic_status: Type.Optional(Type.String()),
    results: Type.Optional(Type.Array(searchHitSchema)),
    /** 引擎给出的警告（索引降级等），原样转发。 */
    warnings: Type.Optional(Type.Array(Type.String())),
    /** 软失败（search_lanes_unavailable …）的错误码。 */
    code: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
