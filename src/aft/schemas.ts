/**
 * AFT 感知工具的结构化结果 schema。
 *
 * 载荷就是引擎自己的响应字段（去掉 envelope 的 request id），外加一个 `text`——我们自己
 * 渲染（或引擎渲染）的文本，与工具输出一致。字段名与类型来自引擎源码（`v0.64.0` 的
 * serde 结构体与 golden 响应），不是从旧抓包里推断的：
 *
 * - `crates/aft/src/protocol.rs`：`tool_call` 信封（`id` / `success` / `code` / `message`）；
 * - `crates/aft/src/commands/`：`outline.rs`（四种请求模式各一组字段）、`zoom.rs`、
 *   `semantic_search/mod.rs`、`callgraph_store_adapter.rs`（6 个 op）；
 * - `crates/aft/src/list_envelope.rs`：截断/分页信封 `*_list_envelope`。
 *
 * 两条刻意的宽松：
 *
 * 1. 所有引擎字段都是可选。引擎不归我们管，它的响应会省略字段或在预算耗尽时只给部分字段；
 *    声明成必需会让引擎的版本变化把工具调用变成失败。
 * 2. 同一工具名下不同请求模式的字段合在一份 schema 里（outline 四种模式、callgraph 六个
 *    op），脚本按自己传入的参数取用。
 *
 * 载荷只经总线复核一次（见 `src/lib/tool-bus.ts`），因此「宽松」不等于不校验：`text` 必需，
 * 列出的字段类型必须对得上。引擎发出的、我们没声明的字段是外部值，用 `z.object`（strip）
 * 接：不报错，但也不进载荷——脚本只看 `src/codemode/declarations.ts` 渲染出来的类型。
 * 引擎内部结构我们不建模的少数几块（`lanes` / `enrichment` / `structuredContent` 等）
 * 声明成 `z.unknown()`，原样透传。
 */

import { z } from "zod";

// ── tool_call 信封（四个工具共用） ──────────────────────────────────────────

/** `id` 是传输层的事不进载荷；其余字段原样保留。 */
const envelope = {
  text: z.string().describe("引擎渲染的文本，与工具输出一致"),
  /** 软失败（`symbol_not_found` / `callgraph_building` …）时为 false。 */
  success: z.boolean().optional().describe("引擎是否给出了肯定答案"),
  code: z.string().optional().describe("引擎给出否定答案时的错误码"),
  message: z.string().optional().describe("引擎失败时的说明文本"),
  /** watcher / 索引有未落地的变更时为 false。 */
  complete: z.boolean().optional().describe("引擎是否确定给全了结果"),
  gaps: z
    .array(
      z.object({
        kind: z.string().optional(),
        reason: z.string().optional(),
        path: z.string().optional(),
        files: z.array(z.string()).optional(),
      }),
    )
    .optional()
    .describe("结果不完整的原因"),
};

/** 引擎的 `ListEnvelope`：截断了多少、为什么、怎么收窄（各工具的 `*_list_envelope`）。 */
const listEnvelope = z
  .object({
    shown: z.number().optional(),
    total: z
      .object({
        kind: z.string().optional().describe("exact / at_least"),
        value: z.number().optional(),
      })
      .optional(),
    unit: z.string().optional().describe("sites / paths / files / results / items / hops …"),
    reason: z.string().optional(),
    causes: z.array(z.string()).optional(),
    narrow: z.array(z.string()).optional(),
  })
  .optional()
  .describe("列表信封：截断了多少、为什么、怎么收窄");

/** 行号区间（引擎序列化时行号从 1 开始）。 */
const rangeSchema = z.object({
  start_line: z.number().optional(),
  start_col: z.number().optional(),
  end_line: z.number().optional(),
  end_col: z.number().optional(),
});

// ── aft_outline ─────────────────────────────────────────────────────────────

/**
 * `aft_outline`：四种请求模式的字段合在一份 schema 里——
 * 单文件（`text` + `content_files`）、目录 `files: true`（`files` + `files_list_envelope`）、
 * 目录发现模式（`discovered: true` + `files_shown` / `output_truncated`）、多文件数组。
 */
export const aftOutlineStructuredSchema = z.object({
  ...envelope,
  /** 引擎真正读进来的文件（canonical 路径）。 */
  content_files: z.array(z.string()).optional(),
  /** files 模式的文件条目。 */
  files: z
    .array(
      z.object({
        path: z.string().optional(),
        language: z.string().optional(),
        /** 顶层符号数；被预算切掉的文件引擎会省略这个字段。 */
        symbols: z.number().optional(),
        /** 行数；null 表示不在索引里（`line_count_gaps` 列出这些文件）。 */
        lines: z.number().nullish(),
      }),
    )
    .optional(),
  /** 不在索引里的文件。 */
  line_count_gaps: z.array(z.string()).optional(),
  /** 目录发现模式固定给 `true`，据此区分模式。 */
  discovered: z.boolean().optional(),
  /** 目录发现 / 多文件模式：文本被输出预算截断。 */
  output_truncated: z.boolean().optional(),
  /** 目录发现 / 多文件模式：文本里展示了多少文件。 */
  files_shown: z.number().optional(),
  /** 目录发现 / 多文件模式：结尾结构说明（可为空串）。 */
  structure_footer: z.string().optional(),
  /** 遍历触到上限。 */
  walk_truncated: z.boolean().optional(),
  /** 遍历文件数上限（引擎当前是 10000）。 */
  walk_limit: z.number().optional(),
  /** 条目收集触到上限。 */
  collection_truncated: z.boolean().optional(),
  /** 遍历与处理的文件数。 */
  entries_examined: z.number().optional(),
  /** 跳过的外部挂载点数量。 */
  skipped_foreign_mounts: z.number().optional(),
  /** 没检查出来的文件（可空）。 */
  unchecked_files: z.array(z.string()).optional(),
  /** 符号折叠成 rollup 的次数。 */
  rollup_count: z.number().optional(),
  /** 跳过的文件及原因。 */
  skipped_files: z
    .array(z.object({ file: z.string().optional(), reason: z.string().optional() }))
    .optional(),
  /** files 模式被读策略拒绝的路径数。 */
  skipped_denied: z.number().optional(),
  /** 发现模式触到时间上限。 */
  deadline_reached: z.boolean().optional(),
  files_list_envelope: listEnvelope,
});

// ── aft_zoom ────────────────────────────────────────────────────────────────

/** 调用图注解里的一条引用。 */
const callRefSchema = z.object({
  name: z.string().optional(),
  line: z.number().optional(),
  /** 同一行上还有多少条同类引用被折叠。 */
  extra_count: z.number().optional(),
});

/** 单个 target 的引擎响应（`targets[].response`，自己也是完整信封）。 */
const zoomTargetResponseSchema = z.object({
  id: z.string().optional(),
  success: z.boolean().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
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
      /** 同一行上被折叠的其它调用总数（0 时引擎省略）。 */
      other_calls: z.number().optional(),
    })
    .optional(),
  /** 该 target 读进来的文件（canonical 路径）。 */
  content_files: z.array(z.string()).optional(),
  /** `callgraph: true` 且调用图索引未就绪。 */
  callgraph: z
    .object({
      status: z.string().optional().describe("unavailable"),
      code: z.string().optional(),
      index: z.string().optional(),
    })
    .optional(),
  /** 符号歧义时的候选列表。 */
  candidates: z
    .array(
      z.object({
        name: z.string().optional(),
        qualified_name: z.string().optional(),
        kind: z.string().optional(),
        range: rangeSchema.optional(),
        signature: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * `aft_zoom`：`tool_call` 路径永远返回 batch 包装（引擎把入参统一翻成 `targets`），
 * 一个符号一个条目，条目内是完整的单 target 信封。
 */
export const aftZoomStructuredSchema = z.object({
  ...envelope,
  targets: z
    .array(
      z.object({
        /** 调用方传入的 target（文件路径或 URL），引擎用它渲染文本。 */
        targetLabel: z.string().optional(),
        /** 条目对应的符号名。 */
        name: z.string().optional(),
        response: zoomTargetResponseSchema.optional(),
      }),
    )
    .optional()
    .describe("每个符号一个条目，条目内是完整的单 target 信封"),
  /** 全部 target 读进来的文件（canonical 路径）。 */
  content_files: z.array(z.string()).optional(),
});

// ── aft_callgraph ───────────────────────────────────────────────────────────

/**
 * 调用点。callers 与 impact 两个 op 的字段合一份（都为可选，脚本按 op 取用）：
 * callers 的条目是一组带 `symbol` 的引用，impact 的是带 `caller_symbol` / `root` /
 * 该调用点自身 `parameters` 的扁平记录。
 */
const callerSiteSchema = z.object({
  // callers op
  symbol: z.string().optional(),
  line: z.number().optional(),
  /** 仅按名字解析出来的边（可能指向同名符号）。 */
  approximate: z.boolean().optional(),
  /** "definition" / "name_match" 等解析来源。 */
  resolved_by: z.string().optional(),
  /** 宏调用点所在的宏名。 */
  via: z.string().optional(),
  /** `callback_reference`：经回调注册的引用。 */
  relation: z.string().optional(),
  /** 该调用点是否位于测试代码中，无法判定时为 true。 */
  test_status_unknown: z.boolean().optional(),
  // impact op
  caller_symbol: z.string().optional(),
  caller_file: z.string().optional(),
  /** 调用方自己的签名。 */
  signature: z.string().optional(),
  /** main / test / attribute / public_api / no_caller_found：该点若是根，标记根类型。 */
  root: z.string().optional(),
  /** `root: "attribute"` 时的属性名（如 #[tokio::main]）。 */
  attribute: z.string().optional(),
  /** 该调用点的源码行。 */
  call_expression: z.string().optional(),
  /** 调用方自己的形参（与被分析符号的顶层 `parameters` 不是一回事）。 */
  parameters: z.array(z.string()).optional(),
});

/** callers op 的条目：调用点字段之外还带文件与该文件下的调用点。 */
const callerGroupSchema = callerSiteSchema.extend({
  file: z.string().optional(),
  callers: z.array(callerSiteSchema).optional(),
});

/** 调用链 / 数据流上的一跳。三个 op 的字段合一份：trace_to 有 `exported`，
 * trace_data 有 `variable` / `flow_type`（`approximate` 在 trace_data 里总是出现）。 */
const callgraphHopSchema = z.object({
  symbol: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
  signature: z.string().optional(),
  /** 该跳的符号是否导出（仅 true 时出现）。 */
  exported: z.boolean().optional(),
  /** trace_data：该跳流转的变量名。 */
  variable: z.string().optional(),
  /** trace_data：assignment / parameter。 */
  flow_type: z.string().optional(),
  approximate: z.boolean().optional(),
  resolved_by: z.string().optional(),
});

/**
 * `aft_callgraph`：一个工具名下 6 个 op，响应形状各不同（callers 是分组列表、call_tree 是
 * 树、impact 是扁平调用点、trace_to 是路径列表、trace_to_symbol 是单条路径、trace_data 是
 * 数据流跳）。这里把各 op 的锚点与列表都列为可选字段，脚本按 op 取用。
 */
export const aftCallgraphStructuredSchema = z.object({
  ...envelope,
  /** 被查询的符号（callers / impact 的锚点）。 */
  symbol: z.string().optional(),
  file: z.string().optional(),
  /** 目标符号的签名（impact；call_tree 的根节点也有）。 */
  signature: z.string().optional(),
  /** impact：目标符号自己的形参。 */
  parameters: z.array(z.string()).optional(),
  /** callers / impact / call_tree 的截断计数（0 时也出现）。 */
  truncated: z.number().optional(),
  /** callers / impact / call_tree / trace_data 是否因深度上限停下。 */
  depth_limited: z.boolean().optional(),
  /** 被隐藏的测试调用点数量（仅 > 0 时出现）。 */
  hidden_test_callers: z.number().optional(),
  /** callers：扫描过的文件数。 */
  scanned_files: z.number().optional(),
  /** 调用点太多时引擎给的收窄提示。 */
  hub_summary: z
    .object({
      message: z.string().optional(),
      total: z.number().optional(),
      hidden_tests: z.number().optional(),
      shown: z.number().optional(),
      threshold: z.number().optional(),
      limit: z.number().optional(),
      counts_are_lower_bounds: z.boolean().optional(),
    })
    .optional(),
  /** 根类型计数（main / test / attribute / public_api / no_caller_found）。 */
  root_counts: z.record(z.string(), z.number()).optional(),

  // callers / impact
  callers: z.array(callerGroupSchema).optional(),
  total_callers: z.number().optional().describe("过滤前计数（含被隐藏的测试调用点）"),
  total_affected: z.number().optional(),
  affected_files: z.number().optional(),
  /** 回调引用数量（仅 > 0 时出现）。 */
  callback_dependencies: z.number().optional(),
  callback_reference_label: z.string().optional(),
  /** 测试过滤的说明（发生过滤时）。 */
  test_filter_note: z.string().optional(),
  /** 引擎无法判定「是否还有调用点」时的说明。 */
  unresolved_call_sites: z.number().optional(),
  incomplete_reason: z.string().optional(),
  /** Rust 宏提及（仅存在时）。 */
  macro_note: z
    .object({
      message: z.string().optional(),
      mentions: z.number().optional(),
      mentions_is_lower_bound: z.boolean().optional(),
      sites: z.array(z.unknown()).optional(),
    })
    .optional(),
  callers_list_envelope: listEnvelope,
  sites_list_envelope: listEnvelope,

  // call_tree
  /** call_tree 根节点的锚点。 */
  name: z.string().optional(),
  line: z.number().optional(),
  /** call_tree 节点是否解析到定义；false 且无子节点 = 未解析的叶子。 */
  resolved: z.boolean().optional(),
  approximate: z.boolean().optional(),
  resolved_by: z.string().optional(),
  /** call_tree 的子节点（递归形状，引擎自己定义，原样透传）。 */
  children: z.array(z.unknown()).optional(),
  /** call_tree 节点预算耗尽。 */
  nodes_examined: z.number().optional(),
  gap: z.string().optional(),
  tree_list_envelope: listEnvelope,

  // trace_to
  target_symbol: z.string().optional(),
  target_file: z.string().optional(),
  paths: z
    .array(
      z.object({
        /** main / test / attribute / public_api / no_caller_found。 */
        root: z.string().optional(),
        attribute: z.string().optional(),
        hops: z.array(callgraphHopSchema).optional(),
      }),
    )
    .optional(),
  total_paths: z.number().optional(),
  /** `total_paths` 只是下限（仅 true 时出现）。 */
  total_paths_is_lower_bound: z.boolean().optional(),
  /** trace_to 是否触到深度上限。 */
  max_depth_reached: z.boolean().optional(),
  /** trace_to 因上限折叠的路径数。 */
  truncated_paths: z.number().optional(),
  paths_list_envelope: listEnvelope,

  // trace_to_symbol
  /** 单条最短路径（没有路径时为 null）。 */
  path: z.array(callgraphHopSchema).nullish(),
  /** 没有路径时的原因：max_depth_exhausted / no_path_found。 */
  reason: z.string().optional(),
  /** 目标符号歧义时的候选（错误载荷里）。 */
  candidates: z.array(z.unknown()).optional(),

  // trace_data
  /** 被追踪的表达式。 */
  expression: z.string().optional(),
  origin_file: z.string().optional(),
  origin_symbol: z.string().optional(),
  hops: z.array(callgraphHopSchema).optional(),
  hops_list_envelope: listEnvelope,
});

// ── aft_search ──────────────────────────────────────────────────────────────

/** 搜索命中：常规 ranking 条目与降级时的 grep 行共用一份宽条目。 */
const searchHitSchema = z.object({
  file: z.string().optional(),
  name: z.string().optional(),
  kind: z
    .string()
    .optional()
    .describe("符号种类；grep 降级命中是 GrepLine，文件级摘要为 file_summary"),
  start_line: z.number().nullish(),
  end_line: z.number().nullish(),
  /** "matching line" / "line range" / "[file summary]" / "GrepLine"。 */
  location: z.string().optional(),
  score: z.number().optional(),
  /** semantic / anchored / exact / lexical / hybrid。 */
  source: z.string().optional(),
  semantic_score: z.number().nullish(),
  lexical_score: z.number().nullish(),
  /** 该命中由语义与词法共同加分。 */
  hybrid_boosted: z.boolean().optional(),
  exact: z.boolean().optional(),
  snippet: z.string().optional(),
  /** split 查询里该命中来自哪一路。 */
  matched_by: z.string().optional(),
  /** 定义支撑的宿主文件。 */
  supports: z.string().optional(),
  /** grep 行条目：行号、列号与命中文本。 */
  line: z.number().optional(),
  column: z.number().optional(),
  line_text: z.string().optional(),
  match_text: z.string().optional(),
  /** 按文件聚合的 grep 形状：该文件里的其余命中行。 */
  lines: z
    .array(
      z.object({
        line: z.number().optional(),
        column: z.number().optional(),
        line_text: z.string().optional(),
        match_text: z.string().optional(),
      }),
    )
    .optional(),
  /** 按文件聚合的 grep 形状：该文件里还有多少行没给。 */
  more_in_file: z.number().optional(),
});

/** `aft_search`：查询解释 + 命中列表 + 截断/降级状态。 */
export const aftSearchStructuredSchema = z.object({
  ...envelope,
  /** ready / partial：索引整体状态。 */
  status: z.string().optional(),
  query: z.string().optional(),
  /** 本次查询是否包含测试文件（回显请求）。 */
  include_tests: z.boolean().optional(),
  /** 引擎对查询的最终解释（regex / literal / semantic / hybrid / split / lexical）。 */
  interpreted_as: z.string().optional(),
  /** 查询分类（Identifier / split …）。 */
  query_kind: z.string().optional(),
  result_count: z.number().optional(),
  /** 还有更多命中没给。 */
  more_available: z.boolean().optional(),
  /** 命中数触到引擎上限。 */
  engine_capped: z.boolean().optional(),
  /** 语义通道整体降级。 */
  fully_degraded: z.boolean().optional(),
  /** 语义索引状态：ready / building / partial / unavailable / off / external_unindexed … */
  semantic_status: z.string().optional(),
  /** 语义通道不可用，本轮只有词法结果。 */
  semantic_unavailable: z.boolean().optional(),
  /** 只有词法结果（降级）。 */
  lexical_only_fallback: z.boolean().optional(),
  /** 降级字面扫描触到目录遍历上限。 */
  degraded_grep_walk_truncated: z.boolean().optional(),
  degraded_grep_skipped_foreign_mounts: z.number().optional(),
  degraded_grep_file_limit: z.number().optional(),
  degraded_grep_candidate_files: z.number().optional(),
  /** 实际渲染进文本的条数。 */
  rendered_results: z.number().optional(),
  /** 请求带 pattern 时回显。 */
  pattern: z.string().optional(),
  /** split 路径的 pattern 统计。 */
  pattern_summary: z
    .object({
      files_matched: z.number().optional(),
      also_found_by_query: z.number().optional(),
      definition_files: z.number().optional(),
      definition_sites: z.number().optional(),
      examination_capped: z.boolean().optional(),
      files_examined: z.number().optional(),
      candidate_files: z.number().optional(),
      alternatives: z.array(z.string()).optional(),
    })
    .optional(),
  results: z.array(searchHitSchema).optional(),
  /** 引擎给出的警告（索引降级等），原样转发。 */
  warnings: z.array(z.string()).optional(),
  results_list_envelope: listEnvelope,
  /** 检索到的外部根（external 模式）。 */
  external_root: z.string().optional(),
  /** 每 session 一次的语义提示。 */
  semantic_notice: z.string().optional(),
  /** 缓存不可用的原因。 */
  cache_unavailable_reason: z.string().optional(),
  /** 零结果时是否升级到 hybrid 重跑。 */
  zero_result_escalation: z.boolean().optional(),
  escalation_target: z.string().optional(),
  /** external 精确扫描的状态。 */
  exact_sweep: z.unknown().optional(),
  /** 各检索通道的状态（引擎内部结构，原样透传）。 */
  lanes: z.unknown().optional(),
  omitted_lanes: z.array(z.string()).optional(),
  enrichment: z.unknown().optional(),
  /** 各通道的执行统计（引擎内部结构，原样透传）。 */
  structuredContent: z.unknown().optional(),
});
