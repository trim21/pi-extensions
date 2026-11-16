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
 * 1. 所有引擎字段都是可选。引擎不归我们管，它的响应会加字段、换字段名；声明成必需会让
 *    版本一升级就把工具调用变成失败。
 * 2. 嵌套条目（callgraph 的调用点、搜索命中等）把已知字段列全但全部可选——引擎自己也用
 *    `?? "(unknown)"` 兜底，说明这些字段并非永远在场。
 *
 * 载荷只经总线复核一次（见 `src/lib/tool-bus.ts`），因此「宽松」不等于不校验：`text` 必需，
 * 列出的字段类型必须对得上。引擎发出的、我们没声明的字段是外部值，用 `z.object`（strip）
 * 接：不报错，但也不进载荷——脚本只看 `src/lib/codemode/declarations.ts` 声明得出的类型。
 */

import { z } from "zod";

/** 引擎渲染的文本，与工具输出一致。 */
const text = z.string().describe("引擎渲染的文本，与工具输出一致");

/** 软失败（`symbol_not_found` / `callgraph_building` / `search_lanes_unavailable` …）的码。 */
const code = z.string().optional().describe("引擎给出否定答案时的错误码");

/** 引擎的 `success`：软失败时是 false，载荷保留它供脚本判定。 */
const success = z.boolean().optional().describe("引擎是否给出了肯定答案");

/** 行号区间（zoom）：引擎的 Range 序列化时行号从 1 开始。 */
const rangeSchema = z.object({
  start_line: z.number().optional(),
  end_line: z.number().optional(),
  start_col: z.number().optional(),
  end_col: z.number().optional(),
});

/** 调用图注解里的一条引用（zoom 的 calls_out / called_by）。 */
const callRefSchema = z.object({
  name: z.string().optional(),
  line: z.number().optional(),
  /** 同一行上还有多少条同类引用被折叠。 */
  extra_count: z.number().optional(),
});

/** `aft_outline`：单文件模式只有 text（引擎不返回符号树），files 模式带文件条目。 */
export const aftOutlineStructuredSchema = z.object({
  text,
  success,
  code,
  /** 引擎是否确定给全了结果。 */
  complete: z.boolean().optional(),
  /** files 模式（目录 + files: true）的文件条目。 */
  files: z
    .array(
      z.object({
        path: z.string().optional(),
        language: z.string().optional(),
        /** 顶层符号数；未知时引擎省略该字段。 */
        symbols: z.number().optional(),
        /** 行数；null 表示不在索引里（line_count_gaps 列出这些文件）。 */
        lines: z.number().nullish(),
      }),
    )
    .optional(),
  /** 目录遍历触到上限。 */
  walk_truncated: z.boolean().optional(),
  /** 条目收集触到上限。 */
  collection_truncated: z.boolean().optional(),
});

/** `aft_zoom`：单符号源码 + 行号区间 + 同文件调用注解。 */
export const aftZoomStructuredSchema = z.object({
  text,
  success,
  code,
  /** 符号名；行范围模式是 "lines X-Y"，符号歧义时缺省。 */
  name: z.string().optional(),
  /** function / class / method / lines / ambiguous_symbol … */
  kind: z.string().optional(),
  range: rangeSchema.optional(),
  /** 符号源码（不含上下文行）。 */
  content: z.string().optional(),
  context_before: z.array(z.string()).optional(),
  context_after: z.array(z.string()).optional(),
  annotations: z
    .object({
      calls_out: z.array(callRefSchema).optional(),
      called_by: z.array(callRefSchema).optional(),
    })
    .optional(),
});

/** 调用图上的一条位置（callers 的调用点、impact 的受害点）。 */
const callgraphSiteSchema = z.object({
  file: z.string().optional(),
  line: z.number().optional(),
  /** callers 分组的调用符号名。 */
  symbol: z.string().optional(),
  /** impact 的调用点符号名（与 caller_file 成对）。 */
  caller_symbol: z.string().optional(),
  caller_file: z.string().optional(),
  /** impact：该调用点自身是入口（脚本常据此过滤）。 */
  is_entry_point: z.boolean().optional(),
  /** 仅按名字解析出来的边（可能指向同名符号）。 */
  approximate: z.boolean().optional(),
  /** "name_match" 等解析来源。 */
  resolved_by: z.string().optional(),
});

/** 调用链上的一跳（trace_to / trace_to_symbol）。 */
const callgraphHopSchema = z.object({
  symbol: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
  is_entry_point: z.boolean().optional(),
  /** trace_data：该跳流转的变量名与流向。 */
  variable: z.string().optional(),
  flow_type: z.string().optional(),
  approximate: z.boolean().optional(),
  resolved_by: z.string().optional(),
});

/**
 * `callers` 的条目两种形状共用一份宽条目（同一工具名下 6 个 op 只有一份 schema，脚本按
 * 自己传入的 op 取用）：`callers` op 按文件分组（`file` + `callers`），`impact` op 是扁平
 * 调用点（`caller_symbol` / `caller_file` / 该点自身的 `parameters`）。
 */
const callgraphCallersEntrySchema = z.object({
  ...callgraphSiteSchema.shape,
  /** callers op：该文件下的调用点。 */
  callers: z.array(callgraphSiteSchema).optional(),
  /** impact op：该调用点实际传入的实参表达式。 */
  parameters: z.array(z.string()).optional(),
});

/**
 * `aft_callgraph`：一个工具名下 6 个 op，响应形状各不同（callers 是分组列表、call_tree 是
 * 树、impact 是扁平调用点、trace_to 是路径列表、trace_to_symbol 是单条路径、trace_data 是
 * 数据流跳）。这里把各 op 的锚点与列表都列为可选字段，脚本按 op 取用。
 */
export const aftCallgraphStructuredSchema = z.object({
  text,
  success,
  /** 被查询的符号（callers / impact 的锚点）。 */
  symbol: z.string().optional(),
  file: z.string().optional(),
  /** call_tree 根节点的锚点。 */
  name: z.string().optional(),
  line: z.number().optional(),
  signature: z.string().optional(),
  /** callers / impact：调用点列表（两种条目形状共用 `callgraphCallersEntrySchema`）。 */
  callers: z.array(callgraphCallersEntrySchema).optional(),
  /** call_tree 根节点的直接子节点（整棵树在 payload 里，这里只标出形状）。 */
  children: z.array(z.unknown()).optional(),
  /** call_tree 节点是否解析到定义；false 且无子节点 = 未解析的叶子。 */
  resolved: z.boolean().optional(),
  total_callers: z.number().optional(),
  total_affected: z.number().optional(),
  affected_files: z.number().optional(),
  /** impact 的参数表（改签名时要知道）。 */
  parameters: z.array(z.string()).optional(),
  /** trace_to：到目标符号的路径，每条路径是一串跳。 */
  paths: z
    .array(
      z.object({
        hops: z.array(callgraphHopSchema).optional(),
      }),
    )
    .optional(),
  total_paths: z.number().optional(),
  /** trace_to_symbol：单条最短路径（没有路径时为 null）。 */
  path: z.array(callgraphHopSchema).nullish(),
  /** trace_data：值在赋值/参数/返回间的流转。 */
  hops: z.array(callgraphHopSchema).optional(),
  depth_limited: z.boolean().optional(),
  /** 因结果上限被折叠的条目数（引擎给的是数字，不是布尔）。 */
  truncated: z.number().optional(),
  code,
});

/** 搜索命中：常规 ranking 条目（symbol）与降级时的 grep 行共用一份宽条目。 */
const searchHitSchema = z.object({
  file: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  start_line: z.number().nullish(),
  end_line: z.number().nullish(),
  /** "matching line" / "line range" / "[file summary]" / "GrepLine"。 */
  location: z.string().optional(),
  score: z.number().optional(),
  source: z.string().optional(),
  semantic_score: z.number().nullish(),
  lexical_score: z.number().nullish(),
  exact: z.boolean().optional(),
  snippet: z.string().optional(),
  /** grep 行条目：行号、列号与命中文本。 */
  line: z.number().optional(),
  column: z.number().optional(),
  line_text: z.string().optional(),
  match_text: z.string().optional(),
});

/** `aft_search`：查询解释 + 命中列表 + 截断/降级状态。 */
export const aftSearchStructuredSchema = z.object({
  text,
  success,
  query: z.string().optional(),
  /** 引擎对查询的最终解释（regex / literal / semantic / hybrid）。 */
  interpreted_as: z.string().optional(),
  result_count: z.number().optional(),
  complete: z.boolean().optional(),
  /** 还有更多命中没给（与分页上限的区别由引擎的 envelope 说明）。 */
  more_available: z.boolean().optional(),
  engine_capped: z.boolean().optional(),
  /** 语义索引状态：ready / building / disabled / unavailable / external。 */
  semantic_status: z.string().optional(),
  results: z.array(searchHitSchema).optional(),
  /** 引擎给出的警告（索引降级等），原样转发。 */
  warnings: z.array(z.string()).optional(),
  code,
});
