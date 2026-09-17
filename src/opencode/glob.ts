/**
 * opencode 风格 glob 工具。
 *
 * 对齐上游 packages/opencode/src/tool/glob.ts：参数只有 pattern / path，内部执行
 * rg --files（附带 --no-config、pattern 的 --glob，并排除 .git 目录），上限 100 条，
 * 输出绝对路径，空结果 "No files found"。与 claude-code 风格 Glob 的差异是刻意
 * 跟随上游的：尊重 .gitignore、不列隐藏文件、不按修改时间排序。
 *
 * 一处有意差异：path 不存在或不是目录时报错（上游直接让 rg 失败），并给出同目录
 * 相近名字的提示。
 */

import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { didYouMean } from "./files.js";
import { RIPGREP_RESULT_LIMIT, runRipgrep } from "./ripgrep.js";

/** Tool guidance, kept in markdown so it reads like documentation. */
const GLOB_PROMPT = readFileSync(fileURLToPath(new URL("glob.md", import.meta.url)), "utf8").trim();

export function buildGlobArgs(pattern: string): string[] {
  return ["--no-config", "--files", `--glob=${pattern}`, "--glob=!**/.git/**", "."];
}

/** rg --files 输出的路径：去掉前导 `./`，分隔符统一成 `/`。 */
function normalizeRipgrepPath(text: string): string {
  return text.replace(/^(?:\.[\\/])+/u, "").replaceAll("\\", "/");
}

export function renderGlobOutput(files: readonly string[], truncated: boolean): string {
  if (files.length === 0) return "No files found";
  const output = [...files];
  if (truncated) {
    output.push(
      "",
      `(Results are truncated: showing first ${RIPGREP_RESULT_LIMIT} results. Consider using a more specific path or pattern.)`,
    );
  }
  return output.join("\n");
}

async function glob(
  params: { pattern: string; path?: string },
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<{ text: string; search: string; count: number; truncated: boolean }> {
  // resolve 对绝对路径原样返回，相对路径按调用 cwd 解析
  const search = resolve(ctx.cwd, params.path ?? ".");
  let info;
  try {
    info = await stat(search);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      const suggestion = await didYouMean(search);
      throw new Error(
        `Directory does not exist: ${params.path ?? search}. Note: your current working directory is ${ctx.cwd}.${suggestion}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error(`glob path must be a directory: ${search}`);
  }

  const { items, truncated } = await runRipgrep(buildGlobArgs(params.pattern), {
    cwd: search,
    signal,
    limit: RIPGREP_RESULT_LIMIT,
    parse: (line) => (line.length === 0 ? undefined : normalizeRipgrepPath(line)),
  });
  const files = items.map((file) => resolve(search, file));
  return { text: renderGlobOutput(files, truncated), search, count: files.length, truncated };
}

export default function opencodeGlob(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "glob",
    label: "glob",
    description: [
      "Fast file pattern matching that works with any codebase size.",
      'Supports glob patterns such as "**/*.js" and "src/**/*.ts"; results are capped at 100 files.',
    ].join("\n"),
    promptSnippet: "Find files by name patterns",
    promptGuidelines: [GLOB_PROMPT],
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "The glob pattern to match files against" }),
        path: Type.Optional(
          Type.String({
            description:
              'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { text, search, count, truncated } = await glob(params, ctx, signal);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          pendant: {
            subtitle:
              count === 0
                ? `no files in ${search}`
                : `${count} file${count === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`,
          },
        },
      };
    },
  });
}
