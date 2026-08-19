/**
 * ast_edit —— 符号级/AST 感知编辑工具。
 *
 * 用 AFT 的 edit 命令做符号级替换 / 模糊匹配 / 批量编辑，流程：
 *   1. preview（只计算不写盘）拿所有变动文件的 before/after
 *   2. write-guard：工作区内自动放行，外部路径用真实 diff 审批
 *   3. 再次调用 edit（不带 preview）→ AFT 自己原子写盘（备份 + 格式化 +
 *      undo），本工具不再直接写文件
 *
 * 不维护 reads 记账：写盘后模型重新 Read 目标文件即可（与本仓库 Edit 的
 * 防呆不同，ast_edit 不要求先读）。
 */

import {
  type ExtensionAPI,
  generateDiffString,
  generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { requireAbsolutePath } from "../claude-code/common.js";
import { type ToolPendant } from "../lib/pendant.js";
import { guardWriteAccess } from "../lib/write-guard.js";
import { callAftTool } from "./bridge.js";
import { type AftToolContext, bridgeFor, buildPendantMarkdown } from "./tools.js";

// ── 纯函数（可测） ──────────────────────────────────────────────────────────

export interface PreviewFile {
  /** 绝对路径；symbol 模式（顶层 diff）时为调用方传入的 file_path 兜底。 */
  file: string;
  before: string;
  after: string;
}

export interface PreviewExtract {
  files: PreviewFile[];
  /** 任一文件超过 512KB 未返回全文（diff.truncated）。 */
  truncated: boolean;
}

/** AFT preview diff 条目：preview 模式下默认带 before/after，>512KB 只带 truncated。 */
const previewDiffSchema = Type.Object({
  before: Type.Optional(Type.String()),
  after: Type.Optional(Type.String()),
  truncated: Type.Optional(Type.Boolean()),
});

type PreviewDiff = { truncated: true } | { truncated: false; before: string; after: string };

function findDiffObject(value: unknown): PreviewDiff | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!Value.Check(previewDiffSchema, value)) return undefined;
  if (value.truncated === true) return { truncated: true };
  if (value.before === undefined || value.after === undefined) return undefined;
  return { before: value.before, after: value.after, truncated: false };
}

/**
 * 从 AFT edit preview 响应提取所有变动文件的 before/after，供写保护审批。
 * 批量/单文件 edits/glob 模式在 `files[]`（每项带 `file` 与 `diff`）；
 * symbol 模式在顶层 `diff`（file 留空，由调用方兜底）。
 */
export function extractPreviewFiles(response: Record<string, unknown>): PreviewExtract {
  const rawFiles = response.files;
  if (Array.isArray(rawFiles) && rawFiles.length > 0) {
    const files: PreviewFile[] = [];
    let truncated = false;
    for (const raw of rawFiles as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const diff = findDiffObject(entry.diff);
      if (!diff) continue;
      if (diff.truncated) {
        truncated = true;
        continue;
      }
      files.push({
        file: typeof entry.file === "string" ? entry.file : "",
        before: diff.before,
        after: diff.after,
      });
    }
    if (truncated || files.length > 0) return { files, truncated };
  }
  const top = findDiffObject(response.diff);
  if (top) {
    if (top.truncated) return { files: [], truncated: true };
    return {
      files: [{ file: "", before: top.before, after: top.after }],
      truncated: false,
    };
  }
  return { files: [], truncated: false };
}

/** 把本工具的参数名映射到 AFT edit wire 格式。 */
export function mapEditItems(
  items: {
    old_string?: string;
    new_string?: string;
    start_line?: number | string;
    end_line?: number | string;
    content?: string;
    occurrence?: number | string;
  }[],
): Record<string, unknown>[] {
  return items.map((item) => {
    const out: Record<string, unknown> = {};
    if (item.old_string !== undefined) out.oldString = item.old_string;
    if (item.new_string !== undefined) out.newString = item.new_string;
    if (item.start_line !== undefined) out.startLine = item.start_line;
    if (item.end_line !== undefined) out.endLine = item.end_line;
    if (item.content !== undefined) out.content = item.content;
    if (item.occurrence !== undefined) out.occurrence = item.occurrence;
    return out;
  });
}

/**
 * 参照 Edit 工具的结果输出：把 preview 的 before/after 转成行号 diff、
 * unified patch 与首个变更行。多文件（glob 批量）时逐文件拼接 diff/patch，
 * firstChangedLine 取首个文件的。
 */
export function buildEditDiffDetails(
  previewFiles: PreviewFile[],
  fallbackFile: string,
): { diff: string; patch: string; firstChangedLine: number | undefined } {
  const parts = previewFiles.map((f) => {
    const file = f.file || fallbackFile;
    const diff = generateDiffString(f.before, f.after);
    return {
      file,
      diff: diff.diff,
      patch: generateUnifiedPatch(file, f.before, f.after),
      firstChangedLine: diff.firstChangedLine,
    };
  });
  if (parts.length === 0) {
    return { diff: "", patch: "", firstChangedLine: undefined };
  }
  return {
    diff: parts.map((p) => `--- ${p.file}\n${p.diff}`).join("\n"),
    patch: parts.map((p) => `--- ${p.file}\n${p.patch}`).join("\n"),
    firstChangedLine: parts[0]?.firstChangedLine,
  };
}

// ── 工具 ────────────────────────────────────────────────────────────────────

const EditItemParams = Type.Object({
  old_string: Type.Optional(Type.String({ description: "要替换的文本" })),
  new_string: Type.Optional(Type.String({ description: "替换后的文本" })),
  start_line: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: "行范围编辑：起始行（1 起）",
    }),
  ),
  end_line: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: "行范围编辑：结束行",
    }),
  ),
  content: Type.Optional(Type.String({ description: "替换内容；空字符串删除这些行" })),
  occurrence: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: "第几次匹配（0 起）；多匹配时指定",
    }),
  ),
});

const AstEditParams = Type.Object(
  {
    file_path: Type.String({
      description:
        "要修改的文件（绝对路径）；配合 old_string+replace_all 可传绝对路径 glob（如 /path/src/**/*.ts）批量替换多个文件",
    }),
    old_string: Type.Optional(Type.String({ description: "精确/模糊匹配的旧文本" })),
    new_string: Type.Optional(Type.String({ description: "替换后的新文本" })),
    replace_all: Type.Optional(Type.Boolean({ description: "替换所有匹配（默认 false）" })),
    occurrence: Type.Optional(
      Type.Union([Type.Number(), Type.String()], {
        description: "第几次匹配（0 起）；多匹配时指定",
      }),
    ),
    symbol: Type.Optional(Type.String({ description: "要替换的符号名（函数/类等）" })),
    content: Type.Optional(Type.String({ description: "符号的新实现内容" })),
    edits: Type.Optional(
      Type.Array(EditItemParams, {
        description: "批量编辑（原子应用，全部成功或全部失败）",
      }),
    ),
    append_content: Type.Optional(Type.String({ description: "追加到文件末尾" })),
  },
  { additionalProperties: false },
);

function buildWireArgs(
  params: {
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
    occurrence?: number | string;
    symbol?: string;
    content?: string;
    edits?: Record<string, unknown>[];
    append_content?: string;
  },
  filePath: string,
): Record<string, unknown> {
  const rawArgs: Record<string, unknown> = { path: filePath };
  const modes = [
    params.old_string !== undefined,
    params.symbol !== undefined,
    params.edits !== undefined,
    params.append_content !== undefined,
  ].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error(
      "Provide exactly one mode: old_string+new_string, symbol+content, edits, or append_content",
    );
  }
  if (params.old_string !== undefined) {
    if (params.new_string === undefined) {
      throw new Error("'new_string' is required with 'old_string'");
    }
    rawArgs.oldString = params.old_string;
    rawArgs.newString = params.new_string;
    if (params.replace_all) rawArgs.replaceAll = true;
    if (params.occurrence !== undefined) rawArgs.occurrence = params.occurrence;
  } else if (params.symbol !== undefined) {
    if (params.content === undefined) {
      throw new Error("'content' is required with 'symbol'");
    }
    rawArgs.symbol = params.symbol;
    rawArgs.content = params.content;
  } else if (params.edits !== undefined) {
    rawArgs.edits = mapEditItems(params.edits);
  } else if (params.append_content !== undefined) {
    rawArgs.appendContent = params.append_content;
  }
  return rawArgs;
}

export function registerAstEditTool(pi: ExtensionAPI, ctx: AftToolContext): void {
  pi.registerTool({
    name: "ast_edit",
    label: "ast_edit",
    description: [
      "符号级/AST 感知编辑：按符号名替换函数/类实现，或做模糊匹配/批量/追加编辑。",
      "与 Edit 的区别：Edit 是精确字符串替换；ast_edit 支持 symbol+content（符号级，包含装饰器/注释/属性）、",
      "edits[] 批量（原子）、fuzzy 匹配（4 步容错）与 append_content 追加。",
      "old_string + replace_all 且 file_path 为 glob 时批量替换多个文件（结果为所有变动文件）。",
      "写盘由 AFT 原子完成（自动备份、格式化）；调用前先以 preview 计算 diff 套用工作区写保护。",
      "不要求先 Read（与本仓库 Edit 不同）；写入后如需确认可重新 Read 文件。四种模式互斥：",
      "  • old_string + new_string（+ replace_all / occurrence；glob 批量需 replace_all）",
      "  • symbol + content",
      "  • edits[]（每项 old_string+new_string 或 start_line+end_line+content）",
      "  • append_content",
    ].join("\n"),
    promptSnippet: "Symbol-aware / fuzzy file edits via AFT",
    parameters: AstEditParams,
    async execute(_id, params, _signal, _onUpdate, extCtx) {
      const filePath = requireAbsolutePath(params.file_path);
      const rawArgs = buildWireArgs(params, filePath);

      // 第一步：preview（不写盘）拿所有变动文件的 before/after，供写保护审批。
      // preview 必须经 options 传入（bridge 会放到 tool_call 消息顶层），
      // 放进 arguments 会被 AFT 忽略并真的写盘。
      const { response } = await callAftTool(bridgeFor(ctx), "edit", rawArgs, extCtx, {
        preview: true,
      });
      const { files: previewFiles, truncated } = extractPreviewFiles(response);
      if (truncated) {
        throw new Error("ast_edit: file too large for preview (over 512KB)");
      }
      if (previewFiles.length === 0) {
        throw new Error("ast_edit: preview did not return before/after content");
      }

      // 第二步：写保护——工作区内自动放行，外部路径用真实 diff 审批。
      for (const preview of previewFiles) {
        await guardWriteAccess(extCtx, {
          toolName: "ast_edit",
          absolutePath: preview.file || filePath,
          change: { oldText: preview.before, newText: preview.after },
        });
      }

      // 第三步：AFT 原子写盘（备份 + 格式化 + undo），结果由 Rust 格式化返回。
      const { text } = await callAftTool(bridgeFor(ctx), "edit", rawArgs, extCtx);
      const files = previewFiles.map((f) => f.file || filePath);
      return {
        content: [{ type: "text", text }],
        details: {
          files,
          ...buildEditDiffDetails(previewFiles, filePath),
          pendant: {
            markdown: buildPendantMarkdown({
              title: "ast_edit",
              input: params,
              output: text,
            }),
          } satisfies ToolPendant,
        },
      };
    },
  });
}
