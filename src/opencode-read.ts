/**
 * Enhanced Read Tool Extension
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
const SAMPLE_BYTES = 4096;

const SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

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

const IMAGE_SIGNATURES: Array<{
  signature: Uint8Array | ((buf: Uint8Array) => boolean);
  mimeType: string;
}> = [
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
    if (buf[offset + i] !== text.charCodeAt(i)) return false;
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
  if (dotIndex < 0) return false;
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

function truncateHead(
  content: string,
  maxLines: number = DEFAULT_MAX_LINES,
  maxBytes: number = DEFAULT_MAX_BYTES,
): TruncationResult {
  const lines = content ? content.split("\n") : [];
  if (content.endsWith("\n")) lines.pop();
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf-8");

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const firstLineBytes = lines.length > 0 ? Buffer.byteLength(lines[0], "utf-8") : 0;
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLinesArr.push(lines[i]);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
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

  results.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: Type.Object({
      filePath: Type.String({ description: "The absolute path to the file or directory to read" }),
      offset: Type.Optional(
        Type.Number({ description: "The line number to start reading from (1-indexed)" }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "The maximum number of lines to read (defaults to 2000)" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const {
        filePath: rawPath,
        offset,
        limit,
      } = params as { filePath: string; offset?: number; limit?: number };

      const absolutePath = isAbsolute(rawPath) ? rawPath : resolvePath(ctx.cwd, rawPath);

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // Check if path exists
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        const suggestion = await didYouMean(absolutePath);
        return {
          content: [
            { type: "text", text: `File not found: ${absolutePath}${suggestion}` },
          ] as TextContent[],
          details: undefined,
        };
      }

      // --- Directory listing ---
      if (fileStat.isDirectory()) {
        const entries = await formatDirectoryEntries(absolutePath);
        const limitVal = limit ?? DEFAULT_MAX_LINES;
        const offsetVal = offset ?? 1;
        const start = offsetVal <= 0 ? 0 : offsetVal - 1;
        const sliced = entries.slice(start, start + limitVal);
        const totalEntries = entries.length;
        const truncated = start + sliced.length < totalEntries;

        let output = `<path>${absolutePath}</path>\n`;
        output += `<type>directory</type>\n`;
        output += `<entries>\n`;
        output += sliced.join("\n");
        if (truncated) {
          const next = offsetVal + sliced.length;
          output += `\n(Showing ${sliced.length} of ${totalEntries} entries. Use offset=${next} to continue.)`;
        } else {
          output += `\n(${totalEntries} entries)`;
        }
        output += `\n</entries>`;

        return {
          content: [{ type: "text", text: output }] as TextContent[],
          details: undefined,
        };
      }

      // --- File read ---
      let content: (TextContent | ImageContent)[];
      let details: { truncation?: TruncationResult } | undefined;

      // Check accessibility
      try {
        await access(absolutePath, constants.R_OK);
      } catch {
        return {
          content: [{ type: "text", text: `File not readable: ${absolutePath}` }] as TextContent[],
          details: undefined,
        };
      }

      // Check for images
      const mimeType = await detectImageMimeTypeFromFile(absolutePath);
      if (mimeType && SUPPORTED_IMAGE_MIMES.has(mimeType)) {
        const buffer = await readFile(absolutePath);
        const base64 = buffer.toString("base64");
        content = [
          { type: "text", text: `[Image: ${mimeType}, ${formatSize(buffer.length)}]` },
          { type: "image", data: base64, mimeType } as ImageContent,
        ];
        return { content, details: undefined };
      }

      // Read text content
      const buffer = await readFile(absolutePath);
      const sample = buffer.subarray(0, SAMPLE_BYTES);

      // Binary file detection
      if (isBinaryExtension(absolutePath) || isBinaryFileBySample(sample)) {
        return {
          content: [
            { type: "text", text: `Cannot read binary file: ${absolutePath}` },
          ] as TextContent[],
          details: undefined,
        };
      }

      const textContent = buffer.toString("utf-8");
      const allLines = textContent.split("\n");
      const totalFileLines = allLines.length;

      // Apply offset
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;

      if (startLine >= allLines.length) {
        return {
          content: [
            {
              type: "text",
              text: `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
            },
          ] as TextContent[],
          details: undefined,
        };
      }

      // Apply user-specified limit or default truncation
      let selectedContent: string;
      let userLimitedLines: number | undefined;

      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      // Apply byte/line truncation
      const truncation = truncateHead(selectedContent);
      let outputText: string;

      const endLineDisplay = startLineDisplay + truncation.outputLines - 1;

      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
        outputText = `<path>${absolutePath}</path>\n<type>file</type>\n`;
        outputText += `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash to read this line.]`;
        details = { truncation };
      } else {
        const header = `<path>${absolutePath}</path>\n<type>file</type>\n<content>\n`;
        const footer = "\n</content>";
        if (truncation.truncated) {
          const nextOffset = endLineDisplay + 1;
          if (truncation.truncatedBy === "lines") {
            outputText = `${header}${truncation.content}\n\n(Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.)${footer}`;
          } else {
            outputText = `${header}${truncation.content}\n\n(Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.)${footer}`;
          }
          details = { truncation };
        } else if (
          userLimitedLines !== undefined &&
          startLine + userLimitedLines < allLines.length
        ) {
          const remaining = allLines.length - (startLine + userLimitedLines);
          const nextOffset = startLine + userLimitedLines + 1;
          outputText = `${header}${truncation.content}\n\n(${remaining} more lines in file. Use offset=${nextOffset} to continue.)${footer}`;
        } else {
          outputText = `${header}${truncation.content}\n\n(End of file - total ${totalFileLines} lines)${footer}`;
        }
      }

      content = [{ type: "text", text: outputText }] as TextContent[];

      return { content, details };
    },
  });
}
