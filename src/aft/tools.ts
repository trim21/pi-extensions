/**
 * AFT 感知工具：aft_outline / aft_zoom / aft_callgraph / aft_search。
 *
 * 全部只读，不经过写路径；路径参数在本地解析后透传给 AFT bridge，
 * 由 Rust 侧（tree-sitter 符号表 / trigram 索引 / 调用图）计算。
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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

import { callAftTool } from "./bridge.js";

/** 解析 `~` 前缀与相对路径（相对 session cwd）。URL 与绝对路径原样返回。 */
export function resolvePathArg(cwd: string, input: string): string {
  if (input === "~" || input.startsWith("~/")) {
    return join(homedir(), input.slice(1));
  }
  if (input.startsWith("http://") || input.startsWith("https://")) return input;
  return isAbsolute(input) ? input : resolve(cwd, input);
}

interface AftToolContext {
  cwd: string;
  pool: AftTransportPool;
}

function bridgeFor(ctx: AftToolContext): AftProjectTransport {
  return ctx.pool.getBridge(ctx.cwd);
}

const OutlineParams = Type.Object(
  {
    target: Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        "要 outline 的对象：文件路径、目录路径、URL（http:// 或 https://），或文件路径数组。模式自动识别：URL 按前缀、目录按 stat、数组按多文件。目录递归上限 200 个文件。",
    }),
    files: Type.Optional(
      Type.Boolean({
        description:
          "目录模式：为 true 时 target 必须是目录（或目录数组），返回带语言/符号数/字节大小的扁平文件树，而非符号大纲。",
      }),
    ),
    includeTests: Type.Optional(
      Type.Boolean({ description: "目录大纲：包含测试文件。默认 false。" }),
    ),
  },
  { additionalProperties: false },
);

export function registerOutlineTool(pi: ExtensionAPI, ctx: AftToolContext): void {
  pi.registerTool({
    name: "aft_outline",
    label: "aft_outline",
    description: [
      "输出代码文件、目录、URL 的结构化大纲：函数/类/类型等符号及其行号范围；Markdown/HTML 返回标题层级。",
      "用它在读取具体内容之前先了解文件结构（比整文件 read 省 token）。",
      "深入了解某个符号用 aft_zoom；看跨文件调用关系用 aft_callgraph。",
      "target 支持：文件路径（带签名的符号大纲）、目录路径（递归最多 200 文件）、URL、文件路径数组。",
      "files: true 且 target 为目录时返回扁平文件树（语言、顶层符号数、字节大小）。",
    ].join("\n"),
    promptSnippet: "Output structural outline of a file/directory/URL",
    parameters: OutlineParams,
    async execute(_id, params, _signal, _onUpdate, extCtx) {
      const target = coerceTargetParam(params.target);
      if (
        (typeof target !== "string" || target.length === 0) &&
        (!Array.isArray(target) || target.length === 0)
      ) {
        throw new Error("'target' must be a non-empty string or array of strings");
      }
      const filesMode = coerceBoolean(params.files);
      const rawArgs: Record<string, unknown> = {
        target: Array.isArray(target)
          ? target.map((t) => resolvePathArg(extCtx.cwd, t))
          : filesMode || target.startsWith("http://") || target.startsWith("https://")
            ? target
            : resolvePathArg(extCtx.cwd, target),
      };
      if (filesMode) rawArgs.files = true;
      if (params.includeTests !== undefined) rawArgs.includeTests = params.includeTests;

      const { text, response } = await callAftTool(bridgeFor(ctx), "outline", rawArgs, extCtx);
      return {
        content: [{ type: "text", text }],
        details: { input: params, truncated: response.truncated === true },
      };
    },
  });
}

const ZoomTarget = Type.Object({
  path: Type.String({ description: "文件路径（绝对或相对项目根）" }),
  symbol: Type.String({ description: "该文件中的符号名" }),
});

const ZoomParams = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "文件路径（绝对或相对项目根）" })),
    url: Type.Optional(Type.String({ description: "要 zoom 的 HTML/Markdown 文档 URL" })),
    symbols: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "符号名（代码）或标题文本（Markdown/HTML）；字符串或数组（同文件批量查询）。",
      }),
    ),
    targets: Type.Optional(
      Type.Union([ZoomTarget, Type.Array(ZoomTarget)], {
        description: "跨文件批量：`{ path, symbol }` 或数组。与 path/url/symbols 互斥。",
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
      "三种模式互斥，用且仅用一种：`{ path, symbols }`、`{ url, symbols }`、`{ targets }`。",
    ].join("\n"),
    promptSnippet: "Inspect the full source of a named symbol",
    parameters: ZoomParams,
    async execute(_id, params, _signal, _onUpdate, extCtx) {
      const isEmpty = (v: unknown): boolean =>
        v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

      const hasPath = !isEmpty(params.path);
      const hasUrl = !isEmpty(params.url);
      const hasSymbols = !isEmpty(params.symbols);
      const hasTargets = !isEmpty(params.targets);

      if (hasTargets && (hasPath || hasUrl || hasSymbols)) {
        throw new Error("'targets' 与 'path'/'url'/'symbols' 互斥，只能提供一种模式");
      }
      if (hasPath && hasUrl) {
        throw new Error("'path' 与 'url' 互斥，只能提供一种");
      }
      if (!hasTargets && !hasPath && !hasUrl) {
        throw new Error("Provide exactly one of 'path', 'url', or 'targets'");
      }

      const rawArgs: Record<string, unknown> = {};
      if (hasTargets) {
        const targetList = params.targets;
        if (!targetList) {
          throw new Error("'targets' must be a non-empty object or array");
        }
        const list = Array.isArray(targetList) ? targetList : [targetList];
        rawArgs.targets = list.map((t) => ({
          filePath: resolvePathArg(extCtx.cwd, t.path),
          symbol: t.symbol,
        }));
      } else if (hasUrl) {
        rawArgs.url = params.url;
        if (hasSymbols) rawArgs.symbols = params.symbols;
      } else {
        const filePath = params.path;
        if (!filePath) {
          throw new Error("'path' must be a non-empty string");
        }
        rawArgs.filePath = resolvePathArg(extCtx.cwd, filePath);
        if (hasSymbols) rawArgs.symbols = params.symbols;
      }

      const contextLines = coerceOptionalInt(
        params.contextLines,
        "contextLines",
        1,
        Number.MAX_SAFE_INTEGER,
      );
      if (contextLines !== undefined) rawArgs.contextLines = contextLines;
      if (coerceBoolean(params.callgraph)) rawArgs.callgraph = true;

      const { text, response } = await callAftTool(bridgeFor(ctx), "zoom", rawArgs, extCtx);
      return {
        content: [{ type: "text", text }],
        details: { input: params, truncated: response.truncated === true },
      };
    },
  });
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
      return {
        content: [{ type: "text", text: out }],
        details: { input: params, truncated: response.truncated === true },
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

      const { text, response } = await callAftTool(bridgeFor(ctx), "search", rawArgs, extCtx);
      return {
        content: [{ type: "text", text }],
        details: { input: params, truncated: response.truncated === true },
      };
    },
  });
}
