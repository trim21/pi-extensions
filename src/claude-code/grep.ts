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
import { Type } from "typebox";

import { searchRoot, throwIfAborted } from "./common.js";

const GREP_OUTPUT_MODES = ["content", "files_with_matches", "count"] as const;

type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[number];

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
      args.push("--count-matches");
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
  if (params.glob) args.push("--glob", params.glob);
  if (params.type) args.push("--type", params.type);
  if (params.multiline === true) args.push("--multiline", "--multiline-dotall");
  args.push("--", params.pattern, searchRoot(params.path, cwd));
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
 */
export function summarizeCountOutput(output: string): string {
  const lines = output.split("\n").filter((line) => line.includes(":"));
  let occurrences = 0;
  for (const line of lines) {
    const colon = line.lastIndexOf(":");
    occurrences += Number(line.slice(colon + 1)) || 0;
  }
  const files = lines.length;
  const occurrenceLabel = occurrences === 1 ? "occurrence" : "occurrences";
  const fileLabel = files === 1 ? "file" : "files";
  return `${output.trimEnd()}\n\nFound ${occurrences} total ${occurrenceLabel} across ${files} ${fileLabel}.`;
}

export function pageGrepOutput(output: string, offset = 0, headLimit = 0): string {
  const lines = output ? output.replace(/\n$/, "").split("\n") : [];
  if (offset >= lines.length && lines.length > 0) return "No entries at this offset";
  const selected = headLimit > 0 ? lines.slice(offset, offset + headLimit) : lines.slice(offset);
  return truncateOutput(selected.join("\n"));
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
    promptGuidelines: [`--\n${GREP_PROMPT}`],
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
      const mode = params.output_mode ?? "files_with_matches";
      // head_limit defaults to DEFAULT_HEAD_LIMIT; an explicit 0 means unlimited.
      const stdout =
        mode === "files_with_matches" ? await sortFilesByMtime(result.stdout) : result.stdout;
      const text = pageGrepOutput(
        stdout,
        params.offset ?? 0,
        params.head_limit ?? DEFAULT_HEAD_LIMIT,
      );
      if (mode === "count") {
        return {
          content: [{ type: "text", text: summarizeCountOutput(text) }],
          details: undefined,
        };
      }
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
