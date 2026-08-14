/**
 * Enhanced Read Tool Extension
 *
 * Aligned with opencode commit 999be62662 (v1.2.25-1672-g999be62662, 2026-08-12):
 *   https://github.com/anomalyco/opencode/blob/999be62662/packages/opencode/src/tool/read.ts
 * Aligned behaviours: per-line `N: ` line-number prefix, single-line 2000-char
 * truncation, 1-based offset (0 treated as 1), out-of-range offset error,
 * cut/more/end truncation messages, `localeCompare` directory sorting.
 * Known gaps (intentionally not implemented): PDF attachment support,
 * instruction (AGENTS.md) loading and LSP warm-up.
 * BMP sniffing is kept but `image/bmp` is NOT in SUPPORTED_IMAGE_MIMES, so a
 * .bmp file falls through to binary detection — matching opencode, which only
 * serves jpeg/png/gif/webp as attachments.
 *
 * Overrides the built-in `read` tool with additional features inspired by
 * opencode's read implementation:
 *
 * - Directory listing: When the path is a directory, lists its entries
 *   with "/" suffix for directories.
 * - "Did you mean?" suggestions: When a file is not found, searches the
 *   parent directory for similarly-named files.
 * - Binary file detection: Rejects binary files by extension and content
 *   sampling before handing them to the LLM.
 * - Structured output: Uses <path>, <type>, <content>/<entries> XML tags
 *   to help the LLM parse output.
 * - Image support: Detects and serves images as base64 attachments.
 *
 * Install:
 *   cp enhanced-read.ts ~/.pi/agent/extensions/
 *
 * Or for project-local:
 *   cp enhanced-read.ts .pi/extensions/
 */

import { constants } from "node:fs";
import { access, open, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from "node:path";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const MAX_BYTES_LABEL = `${DEFAULT_MAX_BYTES / 1024} KB`;
const SAMPLE_BYTES = 4096;

const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
]);

const IMAGE_SIGNATURES: {
  signature: Uint8Array | ((buf: Uint8Array) => boolean);
  mimeType: string;
}[] = [
  { signature: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" },
  {
    signature: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mimeType: "image/png",
  },
  {
    signature(buf) {
      return startsWithAscii(buf, 0, "GIF");
    },
    mimeType: "image/gif",
  },
  {
    signature(buf) {
      return startsWithAscii(buf, 0, "RIFF") && startsWithAscii(buf, 8, "WEBP");
    },
    mimeType: "image/webp",
  },
  {
    signature(buf) {
      return (
        startsWithAscii(buf, 0, "BM") &&
        buf.length >= 30 &&
        (buf[28] ?? 0) === 1 &&
        [1, 4, 8, 16, 24, 32].includes(buf[28 + 1] ?? 0)
      );
    },
    mimeType: "image/bmp",
  },
];

function startsWithAscii(buf: Uint8Array, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buf[offset + i] !== text.codePointAt(i)) return false;
  }
  return true;
}

function detectImageMimeType(buffer: Uint8Array): string | null {
  for (const { signature, mimeType } of IMAGE_SIGNATURES) {
    if (typeof signature === "function" ? signature(buffer) : startsWith(buffer, signature)) {
      return mimeType;
    }
  }
  return null;
}

function startsWith(buffer: Uint8Array, bytes: Uint8Array): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

async function detectImageMimeTypeFromFile(filePath: string): Promise<string | null> {
  try {
    const fileHandle = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(SAMPLE_BYTES);
      const { bytesRead } = await fileHandle.read(buf, 0, SAMPLE_BYTES, 0);
      return detectImageMimeType(buf.subarray(0, bytesRead));
    } finally {
      await fileHandle.close();
    }
  } catch {
    return null;
  }
}

function isBinaryExtension(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(dotIndex).toLowerCase());
}

function isBinaryFileBySample(sample: Uint8Array): boolean {
  if (sample.length === 0) return false;
  let nonPrintableCount = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintableCount++;
  }
  return nonPrintableCount / sample.length > 0.3;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  maxLines: number;
  maxBytes: number;
}

/**
 * Truncate the head of `content` the way opencode's ReadTool.lines does:
 * - per-line truncation to MAX_LINE_LENGTH chars (with MAX_LINE_SUFFIX)
 * - line cap via maxLines (more)
 * - byte cap via maxBytes, computed on the truncated lines (cut)
 */
export function truncateHead(
  content: string,
  maxLines: number = DEFAULT_MAX_LINES,
  maxBytes: number = DEFAULT_MAX_BYTES,
): TruncationResult {
  const lines = content ? content.split("\n") : [];
  if (content.endsWith("\n")) lines.pop();
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf8");

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncated = false;
  let truncatedBy: "lines" | "bytes" | null = null;

  for (const rawLine of lines) {
    // opencode: 行数到达 limit 即截断（more）
    if (outputLinesArr.length >= maxLines) {
      truncated = true;
      truncatedBy = "lines";
      break;
    }
    // opencode: 单行超过 MAX_LINE_LENGTH 截断并追加提示
    const line =
      rawLine.length > MAX_LINE_LENGTH
        ? rawLine.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
        : rawLine;
    const lineBytes = Buffer.byteLength(line, "utf8") + (outputLinesArr.length > 0 ? 1 : 0);
    // opencode: 累计字节超 MAX_BYTES 即截断（cut，优先于 more）
    if (outputBytesCount + lineBytes > maxBytes) {
      truncated = true;
      truncatedBy = "bytes";
      break;
    }
    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }

  const outputContent = outputLinesArr.join("\n");
  return {
    content: outputContent,
    truncated,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: Buffer.byteLength(outputContent, "utf8"),
    maxLines,
    maxBytes,
  };
}

async function didYouMean(filePath: string): Promise<string> {
  const dir = dirname(filePath);
  const base = basename(filePath);

  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return "";
  }

  const candidates = items
    .filter(
      (item) =>
        item.toLowerCase().includes(base.toLowerCase()) ||
        base.toLowerCase().includes(item.toLowerCase()),
    )
    .slice(0, 3)
    .map((item) => `${dir}${sep}${item}`);

  if (candidates.length > 0) {
    return `\n\nDid you mean one of these?\n${candidates.join("\n")}`;
  }
  return "";
}

async function formatDirectoryEntries(dirPath: string): Promise<string[]> {
  const items = await readdir(dirPath);
  const results: string[] = [];

  for (const item of items) {
    let isDir = false;
    try {
      const s = await stat(`${dirPath}${sep}${item}`);
      isDir = s.isDirectory();
    } catch {
      // Use name as-is if stat fails
    }
    results.push(item + (isDir ? "/" : ""));
  }

  // opencode: items.sort((a, b) => a.localeCompare(b))
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

export default function opencodeRead(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: Type.Object({
      filePath: Type.String({ description: "The absolute path to the file or directory to read" }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "The line number to start reading from (1-indexed)",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "The maximum number of lines to read (defaults to 2000)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const { filePath: rawPath, offset, limit } = params;

      const absolutePath = isAbsolute(rawPath) ? rawPath : resolvePath(ctx.cwd, rawPath);

      // Check if path exists
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        const suggestion = await didYouMean(absolutePath);
        return {
          content: [{ type: "text", text: `File not found: ${absolutePath}${suggestion}` }],
          details: undefined,
        };
      }

      // --- Directory listing ---
      if (fileStat.isDirectory()) {
        const entries = await formatDirectoryEntries(absolutePath);
        const limitVal = limit ?? DEFAULT_MAX_LINES;
        // opencode: params.offset || 1（0 视为 1）
        const offsetVal = offset || 1;
        const start = offsetVal - 1;
        const sliced = entries.slice(start, start + limitVal);
        const totalEntries = entries.length;
        const truncated = start + sliced.length < totalEntries;

        let output = `<path>${absolutePath}</path>\n`;
        output += `<type>directory</type>\n`;
        output += `<entries>\n`;
        output += sliced.join("\n");
        if (truncated) {
          output += `\n(Showing ${sliced.length} of ${totalEntries} entries. Use 'offset' parameter to read beyond entry ${offsetVal + sliced.length})`;
        } else {
          output += `\n(${totalEntries} entries)`;
        }
        output += `\n</entries>`;

        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      // --- File read ---

      // Check accessibility
      try {
        await access(absolutePath, constants.R_OK);
      } catch {
        return {
          content: [{ type: "text", text: `File not readable: ${absolutePath}` }],
          details: undefined,
        };
      }

      let content: (TextContent | ImageContent)[];

      // Check for images
      const mimeType = await detectImageMimeTypeFromFile(absolutePath);
      if (mimeType && SUPPORTED_IMAGE_MIMES.has(mimeType)) {
        const buffer = await readFile(absolutePath);
        const base64 = buffer.toString("base64");
        content = [
          // opencode: output is "Image read successfully"
          { type: "text", text: "Image read successfully" },
          { type: "image", data: base64, mimeType },
        ];
        return { content, details: undefined };
      }

      // Read text content
      const buffer = await readFile(absolutePath);
      const sample = buffer.subarray(0, SAMPLE_BYTES);

      // Binary file detection
      if (isBinaryExtension(absolutePath) || isBinaryFileBySample(sample)) {
        return {
          content: [{ type: "text", text: `Cannot read binary file: ${absolutePath}` }],
          details: undefined,
        };
      }

      const textContent = buffer.toString("utf8");
      // opencode 用 Stream.splitLines，不含末尾换行产生的空行
      const allLines = textContent.split("\n");
      if (textContent.endsWith("\n")) allLines.pop();
      const totalFileLines = allLines.length;

      // opencode: offset 1 起始，offset=0 视为 1（params.offset || 1）
      const effectiveOffset = offset || 1;
      const startLine = Math.max(0, effectiveOffset - 1);

      // opencode: 越界报错（空文件 + offset=1 除外）
      if (totalFileLines < effectiveOffset && !(totalFileLines === 0 && effectiveOffset === 1)) {
        throw new Error(
          `Offset ${effectiveOffset} is out of range for this file (${totalFileLines} lines)`,
        );
      }

      const startLineDisplay = startLine + 1;

      // opencode: limit 即行数上限（默认 2000）
      const selectedContent = allLines.slice(startLine).join("\n");
      const truncation = truncateHead(selectedContent, limit ?? DEFAULT_MAX_LINES);
      let outputText: string;

      const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
      const header = `<path>${absolutePath}</path>\n<type>file</type>\n<content>\n`;
      const footer = "\n</content>";
      // opencode: 每行 `${i + offset}: ${line}` 行号前缀
      const numbered =
        truncation.content === ""
          ? ""
          : truncation.content
              .split("\n")
              .map((line, i) => `${startLineDisplay + i}: ${line}`)
              .join("\n");

      let details: { truncation?: TruncationResult } | undefined;
      if (truncation.truncated) {
        const nextOffset = endLineDisplay + 1;
        if (truncation.truncatedBy === "bytes") {
          outputText = `${header}${numbered}\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${startLineDisplay}-${endLineDisplay}. Use offset=${nextOffset} to continue.)${footer}`;
        } else {
          outputText = `${header}${numbered}\n\n(Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.)${footer}`;
        }
        details = { truncation };
      } else {
        outputText = `${header}${numbered}\n\n(End of file - total ${totalFileLines} lines)${footer}`;
      }

      content = [{ type: "text", text: outputText }];

      return { content, details };
    },
  });
}
