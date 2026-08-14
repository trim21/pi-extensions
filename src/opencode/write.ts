/**
 * Enhanced Write Tool Extension
 *
 * Aligned with opencode commit 999be62662 (v1.2.25-1672-g999be62662, 2026-08-12):
 *   https://github.com/anomalyco/opencode/blob/999be62662/packages/opencode/src/tool/write.ts
 * Aligned behaviours: BOM preservation (source.bom || next.bom).
 * Known gaps (intentionally not implemented): LSP diagnostics in the result,
 * formatter run. Unlike opencode (which has no write lock), this extension
 * serialises writes via the mutation queue.
 *
 * Overrides the built-in `write` tool with opencode-compatible parameter names.
 *
 * - Uses `filePath` (opencode) instead of `path` (pi built-in)
 * - Creates parent directories automatically
 * - Serialises writes to the same file via mutation queue
 *
 * Install:
 *   cp enhanced-write.ts ~/.pi/agent/extensions/
 *
 * Or for project-local:
 *   cp enhanced-write.ts .pi/extensions/
 */

import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { stripBom } from "./edit-engine.js";

/**
 * opencode: desiredBom = source.bom || next.bom —— 优先保留原文件 BOM，
 * 否则用新内容自带的 BOM。
 * @param existing - 旧文件前几个字节（undefined 表示文件不存在）
 * @param content - 要写入的完整内容
 */
export function resolveBom(
  existing: Buffer | undefined,
  content: string,
): { bom: string; text: string } {
  const sourceBom =
    existing !== undefined &&
    existing.length >= 3 &&
    existing[0] === 0xef &&
    existing[1] === 0xbb &&
    existing[2] === 0xbf
      ? "\uFEFF"
      : "";
  const { bom: nextBom, text } = stripBom(content);
  return { bom: sourceBom || nextBom, text };
}

export default function opencodeWrite(pi: ExtensionAPI) {
  pi.registerTool({
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    promptSnippet: "Create or overwrite files",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    parameters: Type.Object({
      filePath: Type.String({
        description: "The absolute path to the file to write (must be absolute, not relative)",
      }),
      content: Type.String({ description: "The content to write to the file" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { filePath: rawPath, content } = params;
      const absolutePath = resolvePath(ctx.cwd, rawPath);
      const dir = dirname(absolutePath);

      const throwIfAborted = () => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };

      return withFileMutationQueue(absolutePath, async () => {
        throwIfAborted();

        // opencode: desiredBom = source.bom || next.bom —— 保留原文件 BOM，
        // 否则用新内容自带的 BOM
        let existing: Buffer | undefined;
        try {
          const fh = await open(absolutePath, "r");
          try {
            existing = Buffer.alloc(3);
            const { bytesRead } = await fh.read(existing, 0, 3, 0);
            if (bytesRead < 3) existing = undefined;
          } finally {
            await fh.close();
          }
        } catch {
          // 文件不存在：无旧 BOM
        }
        throwIfAborted();
        const { bom: desiredBom, text: nextText } = resolveBom(existing, content);

        await mkdir(dir, { recursive: true });
        throwIfAborted();
        await writeFile(absolutePath, desiredBom + nextText, "utf8");
        throwIfAborted();

        return {
          content: [{ type: "text", text: "Wrote file successfully." }],
          details: undefined,
        };
      });
    },
  });
}
