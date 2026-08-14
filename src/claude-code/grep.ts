/**
 * Claude Code style `Grep` tool — powerful ripgrep-based search.
 *
 * Split out of the former search.ts so spawn-agent subagents can load it
 * independently (declare `Grep` in the frontmatter to get only this tool).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { searchRoot, throwIfAborted } from "./common.js";

const GREP_OUTPUT_MODES = ["content", "files_with_matches", "count"] as const;

type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[number];

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

export function registerGrepTool(pi: ExtensionAPI): void {
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
