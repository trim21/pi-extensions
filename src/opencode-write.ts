/**
 * Enhanced Write Tool Extension
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

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
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
      const { filePath: rawPath, content } = params as { filePath: string; content: string };
      const absolutePath = resolvePath(ctx.cwd, rawPath);
      const dir = dirname(absolutePath);

      return withFileMutationQueue(absolutePath, async () => {
        const throwIfAborted = () => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };

        throwIfAborted();
        await mkdir(dir, { recursive: true });
        throwIfAborted();
        await writeFile(absolutePath, content, "utf-8");
        throwIfAborted();

        return {
          content: [{ type: "text", text: `Wrote file successfully: ${absolutePath}` }] as Array<{
            type: "text";
            text: string;
          }>,
          details: undefined,
        };
      });
    },
  });
}
