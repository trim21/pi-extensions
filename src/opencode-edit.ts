/**
 * Opencode Edit Extension — Replaces the built-in edit tool with opencode's
 * schema and matching engine.
 *
 * The matching engine (replacers + replace()) lives in opencode-edit-engine.ts
 * and is also used by workspace-guard for the diff preview.
 *
 * Usage:
 *   pi -e ./opencode-edit.ts
 */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  detectLineEnding,
  normalizeToLF,
  replace,
  restoreLineEndings,
  stripBom,
} from "./opencode-edit-engine.js";

// ── schema ────────────────────────────────────────────────────────────────────

const editSchema = Type.Object({
  filePath: Type.String({ description: "The path to the file to modify (relative or absolute)" }),
  oldString: Type.String({ description: "The text to replace" }),
  newString: Type.String({
    description: "The text to replace it with (must be different from oldString)",
  }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace all occurrences of oldString (default false)" }),
  ),
});

// ── extension ─────────────────────────────────────────────────────────────────

export default function opencodeEdit(pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Performs exact string replacements in an existing file.\n" +
      "The edit will FAIL if oldString is not unique in the file.\n" +
      " * Either provide a larger string with more surrounding context to make it unique, or use replaceAll to change every instance of oldString.",
    promptSnippet:
      "Make targeted string replacements in files using exact oldString/newString matching",
    promptGuidelines: [
      "Prefer editing existing files. Never write new files unless explicitly required.",
      "Use the edit tool for targeted changes. Use oldString/newString with exact matching content.",
      "Keep oldString as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
      "The edit will FAIL if oldString is not found or is found multiple times. Provide more context to make it unique or use replaceAll.",
      "Use replaceAll for renaming variables or replacing all instances of a string.",
    ],
    parameters: editSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const filePath = params.filePath;
      const oldString = params.oldString;
      const newString = params.newString;
      const replaceAll = params.replaceAll ?? false;

      const absolutePath = isAbsolute(filePath) ? filePath : resolve(ctx.cwd, filePath);

      const throwIfAborted = (): void => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };

      return withFileMutationQueue(absolutePath, async () => {
        throwIfAborted();

        try {
          await access(absolutePath, constants.R_OK | constants.W_OK);
        } catch (error: unknown) {
          throwIfAborted();
          const msg =
            error instanceof Error && "code" in error && typeof error.code === "string"
              ? `Error code: ${error.code}`
              : String(error);
          throw new Error(`Could not edit file: ${filePath}. ${msg}.`, { cause: error });
        }
        throwIfAborted();

        const buffer = await readFile(absolutePath);
        const rawContent = buffer.toString("utf8");
        throwIfAborted();

        // Strip BOM then normalize line endings to LF.
        // The opencode replacers split on \n and expect only LF.
        const { bom, text: content } = stripBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);

        const newContent = replace(normalizedContent, oldString, newString, replaceAll);
        throwIfAborted();

        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        await writeFile(absolutePath, finalContent, "utf8");
        throwIfAborted();

        const diffResult = generateDiffString(normalizedContent, newContent);
        const patch = generateUnifiedPatch(filePath, normalizedContent, newContent);
        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully edited ${filePath}`,
            },
          ],
          details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
        };
      });
    },
  });
}
