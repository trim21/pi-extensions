/**
 * Claude Code style `Glob` tool — fast file pattern matching.
 *
 * Split out of the former search.ts so spawn-agent subagents can load it
 * independently (declare `Glob` in the frontmatter to get only this tool).
 */

import { readFileSync } from "node:fs";
import { glob as fsGlob, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { searchRoot, throwIfAborted } from "./common.js";

const GLOB_RESULT_LIMIT = 100;

/** Tool guidance, kept in markdown so it reads like documentation. */
const GLOB_PROMPT = readFileSync(fileURLToPath(new URL("glob.md", import.meta.url)), "utf8").trim();

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

export function registerGlobTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "Glob",
    label: "Glob",
    description: [
      "Fast file pattern matching tool that works with any codebase size.",
      'Supports glob patterns such as "**/*.js" and "src/**/*.ts".',
      "Returns matching file paths sorted by modification time.",
    ].join("\n"),
    promptSnippet: "Find files by name patterns",
    promptGuidelines: [`- -\n${GLOB_PROMPT}`],
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
}
