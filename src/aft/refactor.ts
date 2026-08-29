/**
 * aft_refactor —— workspace-wide refactoring（move / extract / inline）。
 *
 * 参数经 bridge.toolCall 以 agent 工具名 "refactor" 分派，Rust 侧 subc 翻译层
 * 按 op 转成内部命令（move_symbol / extract_function / inline_symbol）。
 * 这些命令不支持 preview，写保护退化为路径级审批（workspace 内自动放行，
 * 外部路径经 write-guard 确认，无 diff 预览）。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { coerceOptionalInt } from "@cortexkit/aft-bridge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type ToolPendant } from "../lib/pendant.js";
import { guardWriteAccess } from "../lib/write-guard.js";
import { callAftTool } from "./bridge.js";
import {
  type AftToolContext,
  bridgeFor,
  buildPendantMarkdown,
  compactArgs,
  resolvePathArg,
} from "./tools.js";

/** 工具使用指南，以 markdown 形式维护，读起来像文档。 */
const REFACTOR_PROMPT = readFileSync(
  fileURLToPath(new URL("refactor.md", import.meta.url)),
  "utf8",
).trim();

const REFACTOR_OPS = ["move", "extract", "inline"] as const;

function requireField(value: unknown, name: string, op: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`'${name}' is required for '${op}' op`);
  }
}

const RefactorParams = Type.Object(
  {
    op: Type.Union(
      REFACTOR_OPS.map((op) => Type.Literal(op)),
      { description: "重构操作" },
    ),
    path: Type.String({
      description: "源文件路径（绝对或相对项目根；move 为符号当前所在文件）",
    }),
    symbol: Type.Optional(Type.String({ description: "符号名（move / inline 必填）" })),
    destination: Type.Optional(Type.String({ description: "目标文件（move 必填）" })),
    scope: Type.Optional(Type.String({ description: "move 消歧作用域" })),
    name: Type.Optional(Type.String({ description: "新函数名（extract 必填）" })),
    start_line: Type.Optional(
      Type.Union([Type.Number(), Type.String()], {
        description: "extract 起始行（1 起，必填）",
      }),
    ),
    end_line: Type.Optional(
      Type.Union([Type.Number(), Type.String()], {
        description: "extract 结束行（含，必填）",
      }),
    ),
    call_site_line: Type.Optional(
      Type.Union([Type.Number(), Type.String()], {
        description: "inline 调用点行号（1 起，必填）",
      }),
    ),
  },
  { additionalProperties: false },
);

export function registerRefactorTool(pi: ExtensionAPI, ctx: AftToolContext): void {
  pi.registerTool({
    name: "aft_refactor",
    label: "aft_refactor",
    description: [
      "workspace-wide 重构：更新跨文件的 import 与引用。",
      "move：把顶层符号（非嵌套函数/类方法）移到另一文件，全 workspace 重写 import。",
      "extract：把行区间抽成新函数（TS/JS/TSX、Python）。",
      "inline：把调用点替换为函数体。",
    ].join("\n"),
    promptSnippet: "Workspace-wide symbol move / function extraction / inlining",
    promptGuidelines: [REFACTOR_PROMPT],
    parameters: RefactorParams,
    async execute(_id, params, _signal, _onUpdate, extCtx) {
      const startLine = coerceOptionalInt(
        params.start_line,
        "start_line",
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const endLine = coerceOptionalInt(params.end_line, "end_line", 1, Number.MAX_SAFE_INTEGER);
      const callSiteLine = coerceOptionalInt(
        params.call_site_line,
        "call_site_line",
        1,
        Number.MAX_SAFE_INTEGER,
      );

      if (params.op === "move") {
        requireField(params.symbol, "symbol", "move");
        requireField(params.destination, "destination", "move");
      } else if (params.op === "extract") {
        requireField(params.name, "name", "extract");
        if (startLine === undefined) throw new Error("'start_line' is required for 'extract' op");
        if (endLine === undefined) throw new Error("'end_line' is required for 'extract' op");
      } else {
        requireField(params.symbol, "symbol", "inline");
        if (callSiteLine === undefined) {
          throw new Error("'call_site_line' is required for 'inline' op");
        }
      }

      const filePath = resolvePathArg(extCtx.cwd, params.path);
      const destination =
        params.destination === undefined || params.destination.trim() === ""
          ? undefined
          : resolvePathArg(extCtx.cwd, params.destination);

      const targets = destination === undefined ? [filePath] : [filePath, destination];
      for (const target of targets) {
        await guardWriteAccess(extCtx, { toolName: "aft_refactor", absolutePath: target });
      }

      const rawArgs = compactArgs({
        op: params.op,
        path: filePath,
        symbol: params.symbol,
        destination,
        scope: params.scope,
        name: params.name,
        startLine,
        endLine,
        callSiteLine,
      });

      const { text } = await callAftTool(bridgeFor(ctx), "refactor", rawArgs, extCtx);
      return {
        content: [{ type: "text", text }],
        details: {
          files: targets,
          pendant: {
            markdown: buildPendantMarkdown({
              title: "aft_refactor",
              input: params,
              output: text,
            }),
          } satisfies ToolPendant,
        },
      };
    },
  });
}
