/**
 * AFT 感知工具：aft_outline / aft_zoom / aft_callgraph / aft_search。
 *
 * 全部只读，不经过写路径；路径参数在本地解析后透传给 AFT bridge，
 * 由 Rust 侧（tree-sitter 符号表 / trigram 索引 / 调用图）计算。
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  type AftProjectTransport,
  type AftTransportPool,
  coerceBoolean,
  coerceOptionalInt,
  coerceTargetParam,
  formatCallgraphSections,
  PLAIN_CALLGRAPH_THEME,
} from "@cortexkit/aft-bridge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type ToolPendant } from "../lib/pendant.js";
import { callAftTool, SEMANTIC_INDEX_WAIT_TIMEOUT_MS } from "./bridge.js";

/** 解析 `~` 前缀与相对路径（相对 session cwd）。URL 与绝对路径原样返回。 */
export function resolvePathArg(cwd: string, input: string): string {
  if (input === "~" || input.startsWith("~/")) {
    return join(homedir(), input.slice(1));
  }
  if (input.startsWith("http://") || input.startsWith("https://")) return input;
  return isAbsolute(input) ? input : resolve(cwd, input);
}

/** 人类可读的显示路径：cwd 内用 `./…`，home 内用 `~/…`，否则原样绝对路径。 */
export function formatDisplayPath(cwd: string, filePath: string): string {
  const relToCwd = relative(cwd, filePath);
  if (relToCwd !== "" && !relToCwd.startsWith("..") && !isAbsolute(relToCwd)) {
    return `./${relToCwd}`;
  }
  const relToHome = relative(homedir(), filePath);
  if (relToHome !== "" && !relToHome.startsWith("..") && !isAbsolute(relToHome)) {
    return `~/${relToHome}`;
  }
  return filePath;
}

export interface AftToolContext {
  cwd: string;
  pool: AftTransportPool;
}

export function bridgeFor(ctx: AftToolContext): AftProjectTransport {
  return ctx.pool.getBridge(ctx.cwd);
}

/** 人类视角的调用记录：input params + 与 LLM 相同的输出结果。 */
export function buildPendantMarkdown(params: {
  title: string;
  input: unknown;
  output: string;
  truncated?: boolean;
}): string {
  const lines = [
    `## ${params.title}`,
    "",
    "**Input**",
    "",
    "```json",
    JSON.stringify(params.input, null, 2),
    "```",
    "",
    "**Output**",
    "",
    params.output,
  ];
  if (params.truncated) {
    lines.push("", "_输出已截断_");
  }
  return lines.join("\n").trim();
}

const OutlineParams = Type.Object(
  {
    target: Type.String({
      description:
        "要 outline 的对象：文件路径或目录路径。只接受单个 target；目录递归上限 200 个文件。",
    }),
    files: Type.Optional(
      Type.Boolean({
        description:
          "为 true 时 target 必须是目录，返回带语言/符号数/字节大小的扁平文件树，而非符号大纲。默认：target 为目录时 true，为文件时 false。",
      }),
    ),
    includeTests: Type.Optional(
      Type.Boolean({
        description: "目录符号大纲（files: false）模式：包含测试文件。默认 false。",
      }),
    ),
  },
  { additionalProperties: false },
);

export function registerOutlineTool(pi: ExtensionAPI, ctx: AftToolContext): void {
  pi.registerTool({
    name: "aft_outline",
    label: "aft_outline",
    description: [
      "输出代码文件、目录的结构化大纲：函数/类/类型等符号及其行号范围；Markdown/HTML 返回标题层级。",
      "用它在读取具体内容之前先了解文件结构（比整文件 read 省 token）。",
      "深入了解某个符号用 aft_zoom；看跨文件调用关系用 aft_callgraph。",
      "target 支持：文件路径（带签名的符号大纲）、目录路径（递归最多 200 文件）。只接受单个 target。",
      "target 为目录时默认返回扁平文件树（语言、顶层符号数、字节大小）；传 files: false 可改回符号大纲。",
    ].join("\n"),
    promptSnippet: "Output structural outline of a file/directory",
    parameters: OutlineParams,
    async execute(_id, params, _signal, _onUpdate, extCtx) {
      const target = coerceTargetParam(params.target);
      if (typeof target !== "string" || target.length === 0) {
        throw new Error("'target' must be a single path (array targets are not supported)");
      }
      const resolved = resolvePathArg(extCtx.cwd, target);
      let filesMode = coerceBoolean(params.files);
      if (params.files === undefined) {
        const stats = await stat(resolved).catch(() => null);
        filesMode = stats?.isDirectory() ?? false;
      }
      const rawArgs: Record<string, unknown> = {
        target: filesMode ? target : resolved,
      };
      if (filesMode) rawArgs.files = true;
      if (params.includeTests !== undefined) rawArgs.includeTests = params.includeTests;

      const { text, response } = await callAftTool(bridgeFor(ctx), "outline", rawArgs, extCtx);
      const truncated = response.truncated === true;
      return {
        content: [{ type: "text", text }],
        details: {
          truncated,
        },
      };
    },
  });
}

const ZoomParams = Type.Object(
  {
    path: Type.String({ description: "文件路径（绝对或相对项目根）" }),
    symbols: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "符号名（代码）或标题文本；字符串或数组（同文件批量查询）。",
      }),
    ),
    contextLines: Type.Optional(
      Type.Union([Type.Number({ minimum: 1 }), Type.String()], {
        description: "符号前后上下文行数（默认 3）",
      }),
    ),
    callgraph: Type.Optional(
      Type.Boolean({
        description: "附带调用图标注（同文件内 calls-out / called-by）。默认 false 保持输出精简。",
      }),
    ),
  },
  { additionalProperties: false },
);

export function registerZoomTool(pi: ExtensionAPI, ctx: AftToolContext): void {
  pi.registerTool({
    name: "aft_zoom",
    label: "aft_zoom",
    description: [
      "查看命名符号（函数/类/类型）的完整源码，或 Markdown/HTML 的标题段落内容。",
      "需要理解某个具体符号时用它（读整个文件用 read）。",
      "callgraph: true 时附带同文件内的调用关系标注。",
      "同文件多符号用 `symbols` 数组。",
    ].join("\n"),
    promptSnippet: "Inspect the full source of a named symbol",
    parameters: ZoomParams,
    async execute(_id, params, _signal, _onUpdate, extCtx) {
      const rawArgs: Record<string, unknown> = {
        filePath: resolvePathArg(extCtx.cwd, params.path),
        ...(params.symbols && { symbols: params.symbols }),
      };

      const contextLines = coerceOptionalInt(
        params.contextLines,
        "contextLines",
        1,
        Number.MAX_SAFE_INTEGER,
      );
      if (contextLines !== undefined) rawArgs.contextLines = contextLines;
      if (coerceBoolean(params.callgraph)) rawArgs.callgraph = true;

      const subtitle = buildZoomSubtitle(extCtx.cwd, params);

      const { text, response } = await callAftTool(bridgeFor(ctx), "zoom", rawArgs, extCtx);
      const truncated = response.truncated === true;
      return {
        content: [{ type: "text", text }],
        details: {
          truncated,
          pendant: {
            title: "aft_zoom",
            subtitle,
            markdown: buildPendantMarkdown({
              title: "aft_zoom",
              input: params,
              output: text,
              truncated,
            }),
            expanded: true,
          } satisfies ToolPendant,
        },
      };
    },
  });
}

/** 构建 aft_zoom pendant 的 subtitle：`path="…" symbol="…"`。 */
export function buildZoomSubtitle(
  cwd: string,
  params: Type.Static<typeof ZoomParams>,
): string | undefined {
  const symbols = params.symbols;
  const symbolStr = Array.isArray(symbols) ? symbols.join(", ") : symbols;
  const pathPart = `path="${formatDisplayPath(cwd, resolvePathArg(cwd, params.path))}"`;
  return symbolStr ? `${pathPart} symbol="${symbolStr}"` : pathPart;
}

const CALLGRAPH_OPS = [
  "call_tree",
  "callers",
  "trace_to",
  "trace_to_symbol",
  "impact",
  "trace_data",
] as const;

const CallgraphParams = Type.Object(
  {
    op: Type.Union(
      CALLGRAPH_OPS.map((op) => Type.Literal(op)),
      { description: "导航操作" },
    ),
    path: Type.String({
      description: "包含目标符号的源文件（绝对或相对项目根）",
    }),
    symbol: Type.String({ description: "要分析的符号名" }),
    depth: Type.Optional(
      Type.Union([Type.Number({ minimum: 1 }), Type.String()], {
        description: "调用图最大遍历深度",
      }),
    ),
    expression: Type.Optional(Type.String({ description: "要追踪的表达式（op=trace_data 必填）" })),
    toSymbol: Type.Optional(Type.String({ description: "目标符号（op=trace_to_symbol 必填）" })),
    toPath: Type.Optional(Type.String({ description: "目标文件（toSymbol 存在歧义时指定）" })),
    includeTests: Type.Optional(
      Type.Boolean({ description: "callers/路径中包含测试文件。默认 false。" }),
    ),
    includeUnresolved: Type.Optional(
      Type.Boolean({
        description: "逐个显示未解析的外部/stdlib 调用。默认折叠为每父节点一条摘要。",
      }),
    ),
  },
  { additionalProperties: false },
);

/** 只读导航的合法"否定答案"：符号未定义或索引仍在构建——返回文本而非报错。 */
const CALLGRAPH_SOFT_CODES = new Set(["symbol_not_found", "callgraph_building"]);

export function registerCallgraphTool(pi: ExtensionAPI, ctx: AftToolContext): void {
  pi.registerTool({
    name: "aft_callgraph",
    label: "aft_callgraph",
    description: [
      "基于真实调用图回答代码关系问题（谁调用我、影响面、调用链），替代 grep + read 的链条式排查。",
      "op 语义：callers=调用点（改名/改签名前用）；impact=影响面（改一个符号会波及谁）；",
      "call_tree=该函数调用了什么；trace_to=从入口如何执行到某符号；",
      "trace_to_symbol=两符号间最短路径（需 toSymbol，歧义时需 toPath）；trace_data=追踪值在参数/赋值间的流转（需 expression）。",
      "标记：~ = 仅按名字解析的边（可能指向同名符号）；[unresolved] = 未解析到定义的调用点。",
    ].join("\n"),
    promptSnippet: "Call graph and data-flow navigation",
    parameters: CallgraphParams,
    async execute(_id, params, _signal, _onUpdate, extCtx) {
      const rawArgs: Record<string, unknown> = {
        op: params.op,
        filePath: resolvePathArg(extCtx.cwd, params.path),
        symbol: params.symbol,
      };
      const depth = coerceOptionalInt(params.depth, "depth", 1, Number.MAX_SAFE_INTEGER);
      if (depth !== undefined) rawArgs.depth = depth;
      if (params.expression !== undefined && params.expression !== "") {
        rawArgs.expression = params.expression;
      }
      if (params.toSymbol !== undefined && params.toSymbol !== "") {
        rawArgs.toSymbol = params.toSymbol;
      }
      if (params.toPath !== undefined && params.toPath !== "") {
        rawArgs.toFile = resolvePathArg(extCtx.cwd, params.toPath);
      }
      if (params.includeTests !== undefined) rawArgs.includeTests = params.includeTests;
      if (params.includeUnresolved !== undefined) {
        rawArgs.includeUnresolved = params.includeUnresolved;
      }

      const { text, response } = await callAftTool(
        bridgeFor(ctx),
        "callgraph",
        rawArgs,
        extCtx,
        undefined,
        CALLGRAPH_SOFT_CODES,
      );
      const out =
        text ||
        formatCallgraphSections(params.op, response, PLAIN_CALLGRAPH_THEME, {
          includeUnresolved: coerceBoolean(params.includeUnresolved),
        }).join("\n");
      const truncated = response.truncated === true;
      return {
        content: [{ type: "text", text: out }],
        details: {
          truncated,
          pendant: {
            markdown: buildPendantMarkdown({
              title: "aft_callgraph",
              input: params,
              output: out,
              truncated,
            }),
            expanded: true,
          } satisfies ToolPendant,
        },
      };
    },
  });
}

const SearchParams = Type.Object(
  {
    query: Type.String({
      description:
        "搜索意图：概念、标识符、错误串、正则、字面量或文件名。概念类查询用完整自然语言句子，精确的名字/字符串/正则保持简短。",
    }),
    topK: Type.Optional(
      Type.Integer({
        description: "最大结果数（默认 10，最大 100）",
        minimum: 1,
        maximum: 100,
      }),
    ),
    includeTests: Type.Optional(Type.Boolean({ description: "包含测试文件。默认 false。" })),
    path: Type.Optional(
      Type.String({
        description: "仅当要搜索不同的 Git 项目时设置（绝对或 ~ 路径）。默认搜索当前项目。",
      }),
    ),
  },
  { additionalProperties: false },
);

export function registerSearchTool(pi: ExtensionAPI, ctx: AftToolContext): void {
  pi.registerTool({
    name: "aft_search",
    label: "aft_search",
    description: [
      "一个工具完成代码搜索：概念、标识符、错误串、正则、字面量、文件名自动路由到合适的引擎并按相关度排序。",
      "概念类查询（'ORM 如何构建并执行查询'）用自然语言整句——语义通道理解意图并匹配 docstring 和注释；",
      "精确名字、字符串、正则保持简短（'^export'、'Cargo.lock'）。",
      "需要语义索引可用（aft.jsonc 中 semantic_search: true 且 embedding 后端就绪）；",
      "否则退化为词法/正则匹配通道。",
      "启用语义索引时，首次调用会阻塞到索引构建完成，避免返回部分结果。",
    ].join("\n"),
    promptSnippet: "Search code by meaning or exact text",
    parameters: SearchParams,
    async execute(_id, params, _signal, _onUpdate, extCtx) {
      if (typeof params.query !== "string" || params.query.trim().length === 0) {
        throw new Error("'query' must be a non-empty string");
      }
      const rawArgs: Record<string, unknown> = { query: params.query };
      if (params.topK !== undefined) rawArgs.topK = params.topK;
      if (params.includeTests !== undefined) rawArgs.includeTests = params.includeTests;
      if (params.path !== undefined && params.path !== "") {
        rawArgs.path = resolvePathArg(extCtx.cwd, params.path);
      }

      const { text, response } = await callAftTool(bridgeFor(ctx), "search", rawArgs, extCtx, {
        // 默认 search 传输超时仅 60s，会早于索引等待（600s）触发；覆盖为等待
        // 上限 + 常规执行预算。超时只说明响应被挤掉而非 bridge 挂死，保留
        // 常驻的语义索引/LSP 状态。
        transportTimeoutMs: SEMANTIC_INDEX_WAIT_TIMEOUT_MS + 60_000,
        keepBridgeOnTimeout: true,
      });
      const truncated = response.truncated === true;
      return {
        content: [{ type: "text", text }],
        details: {
          truncated,
          pendant: {
            markdown: buildPendantMarkdown({
              title: "aft_search",
              input: params,
              output: text,
              truncated,
            }),
            expanded: true,
          } satisfies ToolPendant,
        },
      };
    },
  });
}
