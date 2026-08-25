/**
 * Claude Code style `Grep` tool — powerful ripgrep-based search.
 *
 * Split out of the former search.ts so spawn-agent subagents can load it
 * independently (declare `Grep` in the frontmatter to get only this tool).
 *
 * Parameter semantics and default behavior are aligned with Claude Code's
 * GrepTool (ripgrep-based): hidden files searched, VCS directories excluded,
 * lines capped at 500 columns, and an implicit head_limit of 250 entries.
 */

import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { searchRoot, suggestPathUnderCwd, throwIfAborted, toRelativePath } from "./common.js";

const GREP_OUTPUT_MODES = ["content", "files_with_matches", "count"] as const;

/** Tool guidance, kept in markdown so it reads like documentation. */
const GREP_PROMPT = readFileSync(fileURLToPath(new URL("grep.md", import.meta.url)), "utf8").trim();

/** Version control directories excluded from searches (noise in results). */
const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;

/**
 * Default cap on results when head_limit is unspecified. Prevents broad
 * patterns from flooding the context; pass head_limit=0 explicitly for
 * unlimited results. Mirrors Claude Code's default of 250.
 */
const DEFAULT_HEAD_LIMIT = 250;

function truncateOutput(output: string, maxCharacters = 30_000): string {
  if (output.length <= maxCharacters) return output;
  return `${output.slice(0, maxCharacters)}\n\n[Output truncated at ${maxCharacters} characters]`;
}

const grepParametersSchema = Type.Object(
  {
    pattern: Type.String({ description: "The regular expression pattern to search for" }),
    path: Type.Optional(
      Type.String({
        description: "File or directory to search. Defaults to the current directory.",
      }),
    ),
    glob: Type.Optional(Type.String({ description: 'Glob filter such as "*.js" or "*.{ts,tsx}"' })),
    output_mode: Type.Optional(
      StringEnum(GREP_OUTPUT_MODES, {
        description: "Output mode. Defaults to files_with_matches.",
      }),
    ),
    "-B": Type.Optional(
      Type.Number({ description: "Lines to show before each match in content mode" }),
    ),
    "-A": Type.Optional(
      Type.Number({ description: "Lines to show after each match in content mode" }),
    ),
    "-C": Type.Optional(Type.Number({ description: "Lines to show before and after each match" })),
    context: Type.Optional(
      Type.Number({ description: "Lines to show before and after each match" }),
    ),
    "-n": Type.Optional(
      Type.Boolean({ description: "Show line numbers in content mode; defaults true" }),
    ),
    "-i": Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
    type: Type.Optional(
      Type.String({ description: "ripgrep file type such as js, py, rust, or go" }),
    ),
    head_limit: Type.Optional(
      Type.Number({ description: "Limit output to the first N entries after offset" }),
    ),
    offset: Type.Optional(Type.Number({ description: "Skip the first N output entries" })),
    multiline: Type.Optional(
      Type.Boolean({ description: "Allow patterns to span multiple lines" }),
    ),
  },
  { additionalProperties: false },
);

type GrepParameters = Static<typeof grepParametersSchema>;

export function buildGrepArguments(params: GrepParameters, cwd: string): string[] {
  const mode = params.output_mode ?? "files_with_matches";
  const args = ["--color=never", "--hidden", "--max-columns", "500"];
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`);
  }
  switch (mode) {
    case "files_with_matches": {
      args.push("--files-with-matches");
      break;
    }
    case "count": {
      // -c 统计匹配行数（对齐 Claude Code；--count-matches 是匹配次数）
      args.push("-c");
      break;
    }
    case "content": {
      args.push("--no-heading", "--with-filename");
      const showLineNumbers = params["-n"] === true || params["-n"] === undefined;
      if (showLineNumbers) args.push("--line-number");
      const before = params["-B"];
      const after = params["-A"];
      const around = params.context ?? params["-C"];
      if (around === undefined) {
        if (before !== undefined) args.push("--before-context", String(before));
        if (after !== undefined) args.push("--after-context", String(after));
      } else args.push("--context", String(around));

      break;
    }
    // No default
  }
  if (params["-i"] === true) args.push("--ignore-case");
  if (params.type) args.push("--type", params.type);
  if (params.multiline === true) args.push("--multiline", "--multiline-dotall");
  // glob 按逗号/空格拆分（花括号模式不拆），对齐 Claude Code
  if (params.glob) {
    const globPatterns: string[] = [];
    for (const rawPattern of params.glob.split(/\s+/)) {
      if (rawPattern.includes("{") && rawPattern.includes("}")) {
        globPatterns.push(rawPattern);
      } else {
        globPatterns.push(...rawPattern.split(",").filter(Boolean));
      }
    }
    for (const globPattern of globPatterns) {
      if (globPattern) args.push("--glob", globPattern);
    }
  }
  // 以 - 开头的 pattern 用 -e 显式声明，防止被 rg 当作选项
  if (params.pattern.startsWith("-")) args.push("-e", params.pattern);
  else args.push(params.pattern);
  args.push(searchRoot(params.path, cwd));
  return args;
}

/**
 * Sort a newline-separated list of file paths by modification time, most
 * recent first, with file name as a tiebreaker. Files that can no longer be
 * stat-ed sort last (mtime 0). Used for files_with_matches output, matching
 * Claude Code's behaviour.
 */
export async function sortFilesByMtime(output: string): Promise<string> {
  const paths = output.replace(/\n$/, "").split("\n").filter(Boolean);
  if (paths.length <= 1) return output;
  const stats = await Promise.allSettled(paths.map((path) => stat(path)));
  const sorted = paths
    .map((path, index) => ({
      path,
      mtimeMs: stats[index]?.status === "fulfilled" ? stats[index].value.mtimeMs : 0,
    }))
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .map((entry) => entry.path);
  return sorted.join("\n");
}

/**
 * Append an occurrence/file summary to `filename:count` output (count mode),
 * mirroring Claude Code's "Found N occurrences across M files" result.
 * `limitInfo`（如 "limit: 250, offset: 5"）非空时追加 pagination 说明。
 */
export function summarizeCountOutput(output: string, limitInfo?: string): string {
  const lines = output.split("\n").filter((line) => line.includes(":"));
  let occurrences = 0;
  for (const line of lines) {
    const colon = line.lastIndexOf(":");
    occurrences += Number(line.slice(colon + 1)) || 0;
  }
  const files = lines.length;
  const occurrenceLabel = occurrences === 1 ? "occurrence" : "occurrences";
  const fileLabel = files === 1 ? "file" : "files";
  return `${output.trimEnd()}\n\nFound ${occurrences} total ${occurrenceLabel} across ${files} ${fileLabel}.${limitInfo ? ` with pagination = ${limitInfo}` : ""}`;
}

/**
 * 对齐 Claude Code 的 applyHeadLimit：offset 跳过前 N 条；head_limit=0 表示
 * 无限；appliedLimit 仅在真正截断时返回（模型据此知道可以继续分页）。
 */
export function pageGrepOutput(
  output: string,
  offset = 0,
  headLimit = 0,
): { lines: string[]; appliedLimit: number | undefined; appliedOffset: number | undefined } {
  const lines = output ? output.replace(/\n$/, "").split("\n") : [];
  if (headLimit === 0) {
    return {
      lines: lines.slice(offset),
      appliedLimit: undefined,
      appliedOffset: offset > 0 ? offset : undefined,
    };
  }
  const sliced = lines.slice(offset, offset + headLimit);
  return {
    lines: sliced,
    appliedLimit: lines.length - offset > headLimit ? headLimit : undefined,
    appliedOffset: offset > 0 ? offset : undefined,
  };
}

/** 分页信息文本，仅包含实际发生/提供的部分（对齐 Claude Code）。 */
function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`);
  return parts.join(", ");
}

/** content 模式行：路径前缀相对化（`/abs/path:line:content` 取第一个冒号）。 */
function relativizeContentLine(line: string, cwd: string): string {
  const colonIndex = line.indexOf(":");
  if (colonIndex > 0) {
    return toRelativePath(line.slice(0, colonIndex), cwd) + line.slice(colonIndex);
  }
  return line;
}

/** count 模式行：路径前缀相对化（`/abs/path:count` 取最后一个冒号）。 */
function relativizeCountLine(line: string, cwd: string): string {
  const colonIndex = line.lastIndexOf(":");
  if (colonIndex > 0) {
    return toRelativePath(line.slice(0, colonIndex), cwd) + line.slice(colonIndex);
  }
  return line;
}

export function registerGrepTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "Grep",
    label: "Grep",
    description: [
      "A powerful search tool built on ripgrep.",
      "Supports regular expressions, file globs, file types, multiline matching, context lines, and paginated output.",
      'output_mode defaults to "files_with_matches"; use "content" for matching lines or "count" for match counts.',
    ].join("\n"),
    promptSnippet: "Search file contents with regular expressions",
    promptGuidelines: [GREP_PROMPT],
    parameters: grepParametersSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (
        params.offset !== undefined &&
        (!Number.isSafeInteger(params.offset) || params.offset < 0)
      ) {
        throw new Error("offset must be a non-negative integer");
      }
      if (
        params.head_limit !== undefined &&
        (!Number.isSafeInteger(params.head_limit) || params.head_limit < 0)
      ) {
        throw new Error("head_limit must be a non-negative integer");
      }
      if (params.path) {
        const absolutePath = searchRoot(params.path, ctx.cwd);
        try {
          await stat(absolutePath);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            const suggestion = await suggestPathUnderCwd(absolutePath, ctx.cwd);
            throw new Error(
              `Path does not exist: ${params.path}. Note: your current working directory is ${ctx.cwd}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
              { cause: error },
            );
          }
          throw error;
        }
      }
      const result = await pi.exec("rg", buildGrepArguments(params, ctx.cwd), { signal });
      throwIfAborted(signal);
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
      }
      const mode = params.output_mode ?? "files_with_matches";
      const offset = params.offset ?? 0;
      const headLimit = params.head_limit ?? DEFAULT_HEAD_LIMIT;
      // rg 退出码 1 = 无匹配，stdout 为空
      const stdout = result.code === 1 ? "" : result.stdout;

      if (mode === "files_with_matches") {
        if (stdout === "") {
          return { content: [{ type: "text", text: "No files found" }], details: undefined };
        }
        const sorted = await sortFilesByMtime(stdout);
        const { lines, appliedLimit, appliedOffset } = pageGrepOutput(sorted, offset, headLimit);
        const filenames = lines.map((filePath) => toRelativePath(filePath, ctx.cwd));
        const limitInfo = formatLimitInfo(appliedLimit, appliedOffset);
        const text = truncateOutput(
          `Found ${filenames.length} ${filenames.length === 1 ? "file" : "files"}${limitInfo ? ` ${limitInfo}` : ""}\n${filenames.join("\n")}`,
        );
        return {
          content: [{ type: "text", text }],
          details: undefined,
        };
      }

      if (mode === "count") {
        if (stdout === "") {
          return {
            content: [
              {
                type: "text",
                text: "No matches found\n\nFound 0 total occurrences across 0 files.",
              },
            ],
            details: undefined,
          };
        }
        const { lines, appliedLimit, appliedOffset } = pageGrepOutput(stdout, offset, headLimit);
        const relativized = lines.map((line) => relativizeCountLine(line, ctx.cwd));
        return {
          content: [
            {
              type: "text",
              text: truncateOutput(
                summarizeCountOutput(
                  relativized.join("\n"),
                  formatLimitInfo(appliedLimit, appliedOffset),
                ),
              ),
            },
          ],
          details: undefined,
        };
      }

      // content mode
      if (stdout === "") {
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      }
      const { lines, appliedLimit, appliedOffset } = pageGrepOutput(stdout, offset, headLimit);
      const relativized = lines.map((line) => relativizeContentLine(line, ctx.cwd)).join("\n");
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset);
      const text = truncateOutput(
        limitInfo
          ? `${relativized}\n\n[Showing results with pagination = ${limitInfo}]`
          : relativized,
      );
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}

// 独立扩展入口：spawn-agent 子代理声明 `Grep` 工具时按本文件 `-e` 加载，
// 无需经 index.ts / search.ts 聚合。registerGrepTool 本身就是 (pi) => void，
// 可直接作为扩展 factory。
export default registerGrepTool;
