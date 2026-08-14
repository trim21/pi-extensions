import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { guardWriteAccess } from "../lib/write-guard.js";
import {
  type ClaudeCodeState,
  type FileSnapshot,
  requireAbsolutePath,
  snapshotsEqual,
  throwIfAborted,
} from "./common.js";

const DEFAULT_READ_LINES = 2000;
const SAMPLE_BYTES = 4096;

/** Tool guidance, kept in markdown so it reads like documentation. */
const READ_PROMPT = readFileSync(fileURLToPath(new URL("read.md", import.meta.url)), "utf8").trim();
const EDIT_PROMPT = readFileSync(fileURLToPath(new URL("edit.md", import.meta.url)), "utf8").trim();
const WRITE_PROMPT = readFileSync(
  fileURLToPath(new URL("write.md", import.meta.url)),
  "utf8",
).trim();
const IMAGE_MIMES = new Map<string, string>([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export interface FileToolDetails {
  diff?: string;
  patch?: string;
  firstChangedLine?: number;
}

function snapshotOf(content: Uint8Array | string, textEditable = true): FileSnapshot {
  return { digest: createHash("sha256").update(content).digest("hex"), textEditable };
}

async function assertReadableFile(filePath: string): Promise<Awaited<ReturnType<typeof stat>>> {
  const value = await stat(filePath);
  if (!value.isFile()) throw new Error(`File not found: ${filePath}`);
  await access(filePath, constants.R_OK);
  return value;
}

function isBinary(sample: Uint8Array): boolean {
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

function splitFileLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export function formatReadOutput(
  content: string,
  offset = 1,
  limit = DEFAULT_READ_LINES,
): { text: string; complete: boolean; totalLines: number } {
  const lines = splitFileLines(content);
  const totalLines = lines.length;
  if (totalLines === 0) {
    if (offset > 1)
      return {
        text: `<system-reminder>Warning: the file exists but has fewer lines than the provided offset (${offset}). The file has 0 lines.</system-reminder>`,
        complete: false,
        totalLines,
      };
    return {
      text: "<system-reminder>Warning: the file exists but has empty contents.</system-reminder>",
      complete: true,
      totalLines,
    };
  }
  if (offset > totalLines) {
    return {
      text: `<system-reminder>Warning: the file exists but has fewer lines than the provided offset (${offset}). The file has ${totalLines} lines.</system-reminder>`,
      complete: false,
      totalLines,
    };
  }

  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = selected
    .map(
      (line, index) =>
        `${String(offset + index).padStart(6)}\t${line.length > 2000 ? line.slice(0, 2000) : line}`,
    )
    .join("\n");
  const complete = offset === 1 && selected.length === totalLines;
  const hasMore = offset - 1 + selected.length < totalLines;
  const notice = hasMore
    ? `\n\n<system-reminder>PARTIAL view: showing lines ${offset}-${offset + selected.length - 1} of ${totalLines}. Use offset and limit to read more.</system-reminder>`
    : "";
  return { text: numbered + notice, complete, totalLines };
}

function countMatches(content: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

export function exactReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString === newString)
    throw new Error("No changes to apply: old_string and new_string are identical.");
  if (oldString === "") throw new Error("old_string must not be empty.");
  const matches = countMatches(content, oldString);
  if (matches === 0) throw new Error("String to replace not found in file.");
  if (!replaceAll && matches > 1) {
    throw new Error(
      `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more context to make old_string unique.`,
    );
  }
  if (replaceAll) return content.split(oldString).join(newString);
  const index = content.indexOf(oldString);
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

async function requireCurrentRead(state: ClaudeCodeState, filePath: string): Promise<void> {
  const readSnapshot = state.reads.get(filePath);
  if (!readSnapshot)
    throw new Error(`File has not been read yet. Read it first before writing to it: ${filePath}`);
  if (!readSnapshot.textEditable) {
    throw new Error(`Cannot edit or overwrite a binary file with a text tool: ${filePath}`);
  }
  const currentContent = await readFile(filePath);
  const current = snapshotOf(currentContent);
  if (!snapshotsEqual(readSnapshot, current)) {
    throw new Error(`File has been modified since read. Read it again before writing: ${filePath}`);
  }
}

export function registerFileTools(pi: ExtensionAPI, state: ClaudeCodeState): void {
  pi.registerTool({
    name: "Read",
    label: "Read",
    description: [
      "Reads a file from the local filesystem. You can access any file directly using this tool.",
      "The file_path parameter must be an absolute path. By default, it reads up to 2000 lines from the beginning.",
      "Results use cat -n style line numbers starting at 1. Images are returned visually.",
      "This tool reads files, not directories.",
    ].join("\n"),
    promptSnippet: "Read files from the local filesystem with line numbers",
    promptGuidelines: [`- -\n${READ_PROMPT}`],
    parameters: Type.Object(
      {
        file_path: Type.String({ description: "The absolute path to the file to read" }),
        offset: Type.Optional(
          Type.Number({ description: "The line number to start reading from" }),
        ),
        limit: Type.Optional(Type.Number({ description: "The number of lines to read" })),
        pages: Type.Optional(
          Type.String({ description: 'Page range for PDF files (for example "1-5" or "3")' }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      throwIfAborted(signal);
      const filePath = requireAbsolutePath(params.file_path);
      if (
        params.offset !== undefined &&
        (!Number.isSafeInteger(params.offset) || params.offset < 1)
      ) {
        throw new Error("offset must be a positive integer");
      }
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
        throw new Error("limit must be a positive integer");
      }
      await assertReadableFile(filePath);
      throwIfAborted(signal);

      const extension = extname(filePath).toLowerCase();
      if (extension === ".pdf") {
        throw new Error(
          "PDF page rendering is not supported by this pi tool host. Use an external PDF extraction tool before calling Read.",
        );
      }
      const imageMime = IMAGE_MIMES.get(extension);
      if (imageMime) {
        const image = await readFile(filePath);
        const data = image.toString("base64");
        const content: (TextContent | ImageContent)[] = [
          { type: "text", text: `Read image file [${imageMime}]` },
          { type: "image", data, mimeType: imageMime },
        ];
        state.reads.set(filePath, snapshotOf(image, false));
        return { content, details: undefined };
      }

      const buffer = await readFile(filePath);
      if (isBinary(buffer.subarray(0, SAMPLE_BYTES)))
        throw new Error(`Cannot read binary file: ${filePath}`);
      const formatted = formatReadOutput(
        buffer.toString("utf8"),
        params.offset ?? 1,
        params.limit ?? DEFAULT_READ_LINES,
      );
      state.reads.set(filePath, snapshotOf(buffer));
      return { content: [{ type: "text", text: formatted.text }], details: undefined };
    },
  });

  pi.registerTool({
    name: "Edit",
    label: "Edit",
    description: [
      "Performs exact string replacements in files.",
      "You must use Read on the file before editing it.",
      "old_string must match exactly and must be unique unless replace_all is true.",
      "This tool does not use regular expressions or fuzzy matching.",
    ].join("\n"),
    promptSnippet: "Make exact string replacements in files",
    promptGuidelines: [`- -\n${EDIT_PROMPT}`],
    parameters: Type.Object(
      {
        file_path: Type.String({ description: "The absolute path to the file to modify" }),
        old_string: Type.String({ description: "The text to replace" }),
        new_string: Type.String({ description: "The text to replace it with" }),
        replace_all: Type.Optional(
          Type.Boolean({ description: "Replace all occurrences of old_string", default: false }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const filePath = requireAbsolutePath(params.file_path);
      await guardWriteAccess(ctx, {
        toolName: "Edit",
        absolutePath: filePath,
        change: {
          oldText: params.old_string,
          newText: params.new_string,
          replaceAll: params.replace_all,
        },
      });
      return withFileMutationQueue(filePath, async () => {
        await requireCurrentRead(state, filePath);
        await access(filePath, constants.R_OK | constants.W_OK);
        const original = await readFile(filePath, "utf8");
        throwIfAborted(signal);
        const updated = exactReplace(
          original,
          params.old_string,
          params.new_string,
          params.replace_all ?? false,
        );
        await writeFile(filePath, updated, "utf8");
        state.reads.set(filePath, snapshotOf(updated));
        const diff = generateDiffString(original, updated);
        return {
          content: [{ type: "text", text: `The file ${filePath} has been updated successfully.` }],
          details: {
            diff: diff.diff,
            patch: generateUnifiedPatch(filePath, original, updated),
            firstChangedLine: diff.firstChangedLine,
          } satisfies FileToolDetails,
        };
      });
    },
  });

  pi.registerTool({
    name: "Write",
    label: "Write",
    description: [
      "Writes a file to the local filesystem.",
      "This tool overwrites an existing file with the full content provided.",
      "If the file exists, you must use Read first. Prefer Edit for partial changes.",
    ].join("\n"),
    promptSnippet: "Create or overwrite files",
    promptGuidelines: [`- -\n${WRITE_PROMPT}`],
    parameters: Type.Object(
      {
        file_path: Type.String({
          description: "The absolute path to the file to write (must be absolute, not relative)",
        }),
        content: Type.String({ description: "The content to write to the file" }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const filePath = requireAbsolutePath(params.file_path);
      await guardWriteAccess(ctx, {
        toolName: "Write",
        absolutePath: filePath,
        change: { oldText: "", newText: params.content },
      });
      return withFileMutationQueue(filePath, async () => {
        let original: string | undefined;
        try {
          const value = await stat(filePath);
          if (value.isFile()) {
            await requireCurrentRead(state, filePath);
            original = await readFile(filePath, "utf8");
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        throwIfAborted(signal);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, params.content, "utf8");
        state.reads.set(filePath, snapshotOf(params.content));
        const diff = generateDiffString(original ?? "", params.content);
        return {
          content: [{ type: "text", text: `File created successfully at: ${filePath}` }],
          details: {
            diff: diff.diff,
            patch: generateUnifiedPatch(filePath, original ?? "", params.content),
            firstChangedLine: diff.firstChangedLine,
          } satisfies FileToolDetails,
        };
      });
    },
  });
}
