/**
 * Opencode Edit Extension — Replaces the built-in edit tool with opencode's
 * schema and matching engine.
 *
 * Aligned with opencode commit 999be62662 (v1.2.25-1672-g999be62662, 2026-08-12):
 *   https://github.com/anomalyco/opencode/blob/999be62662/packages/opencode/src/tool/edit.ts
 * The matching engine (replacers + replace()) is byte-for-byte aligned with
 * opencode (9 replacers, 0.65 similarity threshold, 0.25 line-delta, identical
 * error messages), and empty-oldString file creation is implemented.
 * Known gaps (intentionally not implemented): LSP diagnostics in the result,
 * formatter run.
 *
 * The matching engine (replacers + replace()) lives in opencode-edit-engine.ts
 * and is also used by workspace-guard for the diff preview.
 *
 * Usage:
 *   pi -e ./opencode-edit.ts
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

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

        // opencode: 前置校验，先于空 oldString 分支
        if (oldString === newString) {
          throw new Error("No changes to apply: oldString and newString are identical.");
        }

        // opencode: 空 oldString + 文件不存在 → 创建新文件；文件存在 → 报错
        if (oldString === "") {
          let exists = true;
          try {
            await access(absolutePath, constants.F_OK);
          } catch {
            exists = false;
          }
          throwIfAborted();
          if (exists) {
            throw new Error(
              "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
            );
          }
          // opencode: writeWithDirs 自动创建父目录；newString 开头的 BOM 原样保留
          await mkdir(dirname(absolutePath), { recursive: true });
          throwIfAborted();
          await writeFile(absolutePath, newString, "utf8");
          throwIfAborted();
          return {
            content: [{ type: "text" as const, text: "Edit applied successfully." }],
            details: { diff: "", patch: "", firstChangedLine: 0 },
          };
        }

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
              text: "Edit applied successfully.",
            },
          ],
          details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
        };
      });
    },
  });
}
