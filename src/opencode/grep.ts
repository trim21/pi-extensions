/**
 * opencode 风格 grep 工具。
 *
 * 对齐上游 packages/opencode/src/tool/grep.ts：参数只有 pattern / path / include，
 * 输出以 `Found N matches` 开头、按文件分组（`<path>:` + `  Line N: <text>`），
 * 结果上限 100 条，隐藏文件参与搜索、.git 排除。
 *
 * 三处有意差异（都是上游实现的毛病）：
 * - 行文本去掉 rg JSON 带出的行尾换行，否则每条匹配后面多一个空行；
 * - `path` 指向文件时只搜该文件（上游仍按目录搜索，仅把结果路径按目录解析）；
 * - `path` 不存在时报错（对齐 claude-code 的 Grep），而不是静默返回 No files found。
 */

import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isRecord } from "../lib/narrow.js";
import { parseWithSchema } from "../lib/parse-with-schema.js";
import { didYouMean } from "./files.js";
import { RIPGREP_RESULT_LIMIT, runRipgrep } from "./ripgrep.js";

/** Tool guidance, kept in markdown so it reads like documentation. */
const GREP_PROMPT = readFileSync(fileURLToPath(new URL("grep.md", import.meta.url)), "utf8").trim();

/** 单行文本上限（上游 2000 字符，超出截断加省略号）。 */
const MAX_LINE_LENGTH = 2000;

/** 单条 rg JSON 记录上限（上游 64 KiB）。 */
const MAX_RECORD_BYTES = 64 * 1024;

/** rg --json 的 match 记录（只取工具用到的字段）。 */
const rawMatchSchema = Type.Object({
  data: Type.Object({
    path: Type.Object({ text: Type.String() }),
    lines: Type.Object({ text: Type.String() }),
    line_number: Type.Integer(),
  }),
});

export interface GrepMatch {
  /** 相对 rg cwd 的路径，调用方负责解析成绝对路径。 */
  path: string;
  line: number;
  text: string;
}

/** rg 输出的路径：去掉前导 `./`，分隔符统一成 `/`。 */
function normalizeRipgrepPath(text: string): string {
  return text.replace(/^(?:\.[\\/])+/u, "").replaceAll("\\", "/");
}

/** 行文本：去掉行尾换行，超长截断（不留半个 surrogate pair）。 */
function normalizeLineText(text: string): string {
  const line = text.replace(/[\r\n]+$/u, "");
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  return line.slice(0, MAX_LINE_LENGTH).replace(/[\uD800-\uDBFF]$/u, "") + "...";
}

/**
 * 解析一行 rg --json 输出。非 match 记录（begin/end/summary）返回 undefined；
 * match 记录形状不符或超过大小上限则抛错（损坏的输出不该被当成空结果）。
 */
export function parseGrepRecord(line: string): GrepMatch | undefined {
  if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
    throw new Error(`ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`);
  }
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (error) {
    throw new Error("Invalid ripgrep JSON output", { cause: error });
  }
  if (!isRecord(json) || json.type !== "match") {
    return undefined;
  }
  const record = parseWithSchema(rawMatchSchema, json);
  return {
    path: normalizeRipgrepPath(record.data.path.text),
    line: record.data.line_number,
    text: normalizeLineText(record.data.lines.text),
  };
}

export function buildGrepArgs(
  pattern: string,
  include: string | undefined,
  target: string,
): string[] {
  return [
    "--no-config",
    "--json",
    "--hidden",
    "--no-messages",
    ...(include ? [`--glob=${include}`] : []),
    "--glob=!**/.git/**",
    "--",
    pattern,
    target,
  ];
}

/** 渲染搜索结果：上游格式，按文件分组。 */
export function renderGrepOutput(matches: readonly GrepMatch[], truncated: boolean): string {
  if (matches.length === 0) {
    return "No files found";
  }
  const output = [`Found ${matches.length} matches${truncated ? " (more matches available)" : ""}`];
  let current = "";
  for (const match of matches) {
    if (current !== match.path) {
      if (current !== "") {
        output.push("");
      }
      current = match.path;
      output.push(`${match.path}:`);
    }
    output.push(`  Line ${match.line}: ${match.text}`);
  }
  if (truncated) {
    output.push("", "(Results truncated. Consider using a more specific path or pattern.)");
  }
  return output.join("\n");
}

/** 搜索根：绝对路径原样，相对路径按调用 cwd 解析。 */
export function resolveSearchRoot(path: string | undefined, cwd: string): string {
  if (path === undefined || path === "") {
    return cwd;
  }
  return isAbsolute(path) ? path : join(cwd, path);
}

async function grep(
  params: { pattern: string; path?: string; include?: string },
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<{ text: string; subtitle: string }> {
  if (params.pattern === "") {
    throw new Error("pattern is required");
  }
  const requested = resolveSearchRoot(params.path, ctx.cwd);
  let info;
  try {
    info = await stat(requested);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      const suggestion = await didYouMean(requested);
      throw new Error(
        `Path does not exist: ${params.path ?? requested}. Note: your current working directory is ${ctx.cwd}.${suggestion}`,
        { cause: error },
      );
    }
    throw error;
  }
  // 目录：rg 的 cwd 即该目录、目标为 "."；文件：cwd 取其父目录、目标为该文件
  const searchDir = info.isDirectory() ? requested : dirname(requested);
  const target = info.isDirectory() ? "." : requested;
  const { items, truncated } = await runRipgrep(
    buildGrepArgs(params.pattern, params.include, target),
    { cwd: searchDir, signal, limit: RIPGREP_RESULT_LIMIT, parse: parseGrepRecord },
  );
  const matches = items.map((match) => ({ ...match, path: resolve(searchDir, match.path) }));
  const fileCount = new Set(matches.map((match) => match.path)).size;
  return {
    text: renderGrepOutput(matches, truncated),
    subtitle:
      matches.length === 0
        ? "no matches"
        : `${matches.length} match${matches.length === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`,
  };
}

export default function opencodeGrep(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: [
      "Fast content search with ripgrep: returns matching file paths with line numbers.",
      "Hidden files are searched and .git is excluded; results are capped at 100 matches.",
    ].join("\n"),
    promptSnippet: "Search file contents with ripgrep",
    promptGuidelines: [GREP_PROMPT],
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "The regex pattern to search for in file contents" }),
        path: Type.Optional(
          Type.String({
            description: "The file or directory to search in. Defaults to the working directory.",
          }),
        ),
        include: Type.Optional(
          Type.String({
            description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { text, subtitle } = await grep(params, ctx, signal);
      return {
        content: [{ type: "text" as const, text }],
        details: { pendant: { subtitle } },
      };
    },
  });
}
