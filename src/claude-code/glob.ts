/**
 * Claude Code style `Glob` tool — fast file pattern matching.
 *
 * Split out of the former search.ts so spawn-agent subagents can load it
 * independently (declare `Glob` in the frontmatter to get only this tool).
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { searchRoot, suggestPathUnderCwd, toRelativePath } from "./common.js";

const GLOB_RESULT_LIMIT = 100;

const execFileAsync = promisify(execFile);

/** Tool guidance, kept in markdown so it reads like documentation. */
const GLOB_PROMPT = readFileSync(fileURLToPath(new URL("glob.md", import.meta.url)), "utf8").trim();

/**
 * 从绝对 glob pattern 中提取搜索根目录和相对 pattern（rg 的 --glob 只接受
 * 相对 pattern）。对齐 Claude Code 的 extractGlobBaseDirectory。
 */
function extractGlobBaseDirectory(pattern: string): {
  baseDir: string;
  relativePattern: string;
} {
  const globChars = /[*?[{]/;
  const match = globChars.exec(pattern);
  if (!match || match.index === undefined) {
    // 无 glob 特殊字符：字面路径，目录部分作为 baseDir
    return { baseDir: dirname(pattern), relativePattern: basename(pattern) };
  }
  const staticPrefix = pattern.slice(0, match.index);
  const lastSepIndex = Math.max(staticPrefix.lastIndexOf("/"), staticPrefix.lastIndexOf(sep));
  if (lastSepIndex === -1) return { baseDir: "", relativePattern: pattern };
  let baseDir = staticPrefix.slice(0, lastSepIndex);
  const relativePattern = pattern.slice(lastSepIndex + 1);
  // 根目录 pattern（如 /*.txt）：baseDir 为空但应使用 "/"
  if (baseDir === "" && lastSepIndex === 0) baseDir = "/";
  return { baseDir, relativePattern };
}

/**
 * 对齐 Claude Code 的 glob（rg --files）：按修改时间升序（最旧在前）排序，
 * --no-ignore/--hidden 不尊重 gitignore、包含隐藏文件。相比真实 CC 额外排除
 * .git（--hidden 会列出 .git 内容，属于噪音）。返回截断标记。
 */
export async function globFiles(
  pattern: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  signal?.throwIfAborted();
  let searchDir = cwd;
  let searchPattern = pattern;
  if (isAbsolute(pattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(pattern);
    if (baseDir) {
      searchDir = baseDir;
      searchPattern = relativePattern;
    }
  }
  const args = [
    "--files",
    "--glob",
    searchPattern,
    "--sort=modified",
    "--no-ignore",
    "--hidden",
    "--glob",
    "!.git/**",
  ];
  let stdout: string;
  try {
    const result = await execFileAsync("rg", args, {
      cwd: searchDir,
      maxBuffer: 10 * 1024 * 1024,
      ...(signal && { signal }),
    });
    stdout = result.stdout;
  } catch (error) {
    // rg exit code 1 = 搜索完成但无匹配，对齐 Claude Code 的 ripGrep（正常空结果）
    const code = (error as { code?: unknown }).code;
    if (code === 1) return { files: [], truncated: false };
    const detail =
      (error as { stderr?: string }).stderr?.trim() ||
      (error instanceof Error ? error.message : String(error));
    throw new Error(`ripgrep failed: ${detail}`, { cause: error });
  }
  // rg 输出相对 searchDir 的路径，转成绝对路径
  const lines = stdout ? stdout.replace(/\n$/, "").split("\n") : [];
  const absolutePaths = lines.map((path) => (isAbsolute(path) ? path : join(searchDir, path)));
  return {
    files: absolutePaths.slice(0, GLOB_RESULT_LIMIT),
    truncated: absolutePaths.length > GLOB_RESULT_LIMIT,
  };
}

export function registerGlobTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "Glob",
    label: "Glob",
    description: [
      "Fast file pattern matching tool that works with any codebase size.",
      'Supports glob patterns such as "**/*.js" and "src/**/*.ts".',
      "Returns matching file paths sorted by modification time (oldest first).",
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      const root = searchRoot(params.path, ctx.cwd);
      if (params.path) {
        let stats;
        try {
          stats = await stat(root);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            const suggestion = await suggestPathUnderCwd(root, ctx.cwd);
            throw new Error(
              `Directory does not exist: ${params.path}. Note: your current working directory is ${ctx.cwd}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
              { cause: error },
            );
          }
          throw error;
        }
        if (!stats.isDirectory()) throw new Error(`Path is not a directory: ${params.path}`);
      }
      const { files, truncated } = await globFiles(params.pattern, root, signal);
      const filenames = files.map((filePath) => toRelativePath(filePath, ctx.cwd));
      const lines = truncated
        ? [...filenames, "(Results are truncated. Consider using a more specific path or pattern.)"]
        : filenames;
      return {
        content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No files found" }],
        details: undefined,
      };
    },
  });
}

// 独立扩展入口：spawn-agent 子代理声明 `Glob` 工具时按本文件 `-e` 加载，
// 无需经 index.ts / search.ts 聚合。registerGlobTool 本身就是 (pi) => void，
// 可直接作为扩展 factory。
export default registerGlobTool;
