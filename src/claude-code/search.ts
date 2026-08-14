import { glob as fsGlob, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { throwIfAborted } from "./common.js";

const GLOB_RESULT_LIMIT = 100;
const GREP_OUTPUT_MODES = ["content", "files_with_matches", "count"] as const;

type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[number];

function searchRoot(path: string | undefined, cwd: string): string {
  if (!path) return cwd;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function truncateOutput(output: string, maxCharacters = 30_000): string {
  if (output.length <= maxCharacters) return output;
  return `${output.slice(0, maxCharacters)}\n\n[Output truncated at ${maxCharacters} characters]`;
}

export async function globFiles(
  pattern: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const matches: { path: string; mtimeMs: number }[] = [];
  for await (const match of fsGlob(pattern, { cwd, exclude: [".git/**"], withFileTypes: false })) {
    throwIfAborted(signal);
    const absolutePath = resolve(cwd, match);
    try {
      const value = await stat(absolutePath);
      if (value.isFile()) matches.push({ path: absolutePath, mtimeMs: value.mtimeMs });
    } catch {
      // A concurrent filesystem change can remove a match before stat.
    }
  }
  return matches
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, GLOB_RESULT_LIMIT)
    .map((match) => match.path);
}

interface GrepParameters {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: GrepOutputMode;
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  context?: number;
  "-n"?: boolean;
  "-i"?: boolean;
  type?: string;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

export function buildGrepArguments(params: GrepParameters, cwd: string): string[] {
  const mode = params.output_mode ?? "files_with_matches";
  const args = ["--color=never"];
  switch (mode) {
    case "files_with_matches": {
      args.push("--files-with-matches");
      break;
    }
    case "count": {
      args.push("--count-matches");
      break;
    }
    case "content": {
      args.push("--no-heading", "--with-filename");
      if (params["-n"] !== false) args.push("--line-number");
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
  if (params.glob) args.push("--glob", params.glob);
  if (params.type) args.push("--type", params.type);
  if (params.multiline === true) args.push("--multiline", "--multiline-dotall");
  args.push("--", params.pattern, searchRoot(params.path, cwd));
  return args;
}

export function pageGrepOutput(output: string, offset = 0, headLimit = 0): string {
  const lines = output ? output.replace(/\n$/, "").split("\n") : [];
  if (offset >= lines.length && lines.length > 0) return "No entries at this offset";
  const selected = headLimit > 0 ? lines.slice(offset, offset + headLimit) : lines.slice(offset);
  return truncateOutput(selected.join("\n"));
}

export function registerSearchTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "Glob",
    label: "Glob",
    description: [
      "Fast file pattern matching tool that works with any codebase size.",
      'Supports glob patterns such as "**/*.js" and "src/**/*.ts".',
      "Returns matching file paths sorted by modification time.",
    ].join("\n"),
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "The glob pattern to match files against" }),
        path: Type.Optional(
          Type.String({
            description:
              "The directory to search in. If omitted, the current working directory is used.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const root = searchRoot(params.path, ctx.cwd);
      const matches = await globFiles(params.pattern, root, signal);
      return {
        content: [
          { type: "text", text: matches.length > 0 ? matches.join("\n") : "No files found" },
        ],
        details: { count: matches.length },
      };
    },
  });

  pi.registerTool({
    name: "Grep",
    label: "Grep",
    description: [
      "A powerful search tool built on ripgrep.",
      "Supports regular expressions, file globs, file types, multiline matching, context lines, and paginated output.",
      'output_mode defaults to "files_with_matches"; use "content" for matching lines or "count" for match counts.',
    ].join("\n"),
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "The regular expression pattern to search for" }),
        path: Type.Optional(
          Type.String({
            description: "File or directory to search. Defaults to the current directory.",
          }),
        ),
        glob: Type.Optional(
          Type.String({ description: 'Glob filter such as "*.js" or "*.{ts,tsx}"' }),
        ),
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
        "-C": Type.Optional(
          Type.Number({ description: "Lines to show before and after each match" }),
        ),
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
    ),
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
      const result = await pi.exec("rg", buildGrepArguments(params, ctx.cwd), { signal });
      throwIfAborted(signal);
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
      }
      if (result.code === 1 || result.stdout === "") {
        return { content: [{ type: "text", text: "No files found" }], details: { matches: 0 } };
      }
      const text = pageGrepOutput(result.stdout, params.offset ?? 0, params.head_limit ?? 0);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
