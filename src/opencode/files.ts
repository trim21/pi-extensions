/**
 * Opencode File Tools —— read / edit / write 统一构建点。
 *
 * 三个工具在同一个 registerFileTools(pi, service) 里注册，共享同一个 LSP
 * service 实例（createLspService 的闭包变量），与 claude-code/files.ts 共享
 * read-snapshot state 的方式一致；不再用模块级全局缓存。
 *
 * 各工具行为对齐 opencode commit 999be62662（v1.2.25-1672-g999be62662,
 * 2026-08-12）：
 * - read：每行 `N: ` 行号前缀、单行 2000 字符截断、1 起始 offset、目录
 *   排序；读取后后台 LSP warm-up（fire-and-forget）。
 * - edit：opencode 匹配引擎（9 个 replacer、0.65 相似度阈值、0.25 行差）；
 *   写后等待文档诊断，ERROR 级追加到输出。
 * - write：BOM 保留（source.bom || next.bom）；写后同 edit 的诊断输出。
 *
 * 匹配引擎（replacers + replace()）在 edit-engine.ts，也被 lib/write-guard
 * 复用。spawn-agent 子代理按工具名加载本文件（`--tools` allowlist 过滤）。
 */

import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from "node:path";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createLspService, initLsp, type LspService } from "../lib/lsp/lsp.js";
import { guardWriteAccess } from "../lib/write-guard.js";
import {
  detectLineEnding,
  normalizeToLF,
  replace,
  restoreLineEndings,
  stripBom,
} from "./edit-engine.js";

// ── read 工具 ────────────────────────────────────────────────────────────────

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

function registerReadTool(pi: ExtensionAPI, service: LspService): void {
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

      // opencode: LSP warm-up 是后台任务，失败不影响读取
      void service.touchFile(absolutePath, ctx.cwd).catch(() => {
        // 后台 warm-up 失败不影响读取
      });

      return { content, details };
    },
  });
}

// ── edit 工具 ────────────────────────────────────────────────────────────────

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

function registerEditTool(pi: ExtensionAPI, service: LspService): void {
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

      const absolutePath = isAbsolute(filePath) ? filePath : resolvePath(ctx.cwd, filePath);

      await guardWriteAccess(ctx, {
        toolName: "edit",
        absolutePath,
        change: { oldText: oldString, newText: newString, replaceAll },
      });

      const throwIfAborted = (): void => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };

      const [message, details, diagnosticText] = await withFileMutationQueue(
        absolutePath,
        async () => {
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
            const diagnosticText = await service.lspDiagnosticsForFile(absolutePath, ctx.cwd);
            return [
              "Edit applied successfully.",
              { diff: "", patch: "", firstChangedLine: 0 },
              diagnosticText,
            ] as const;
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
          throwIfAborted();
          const diagnosticText = await service.lspDiagnosticsForFile(absolutePath, ctx.cwd);
          return [
            "Edit applied successfully.",
            { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
            diagnosticText,
          ] as const;
        },
      );

      const text = diagnosticText
        ? `${message}\n\nLSP errors detected in this file, please fix:\n${diagnosticText}`
        : message;
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}

// ── write 工具 ───────────────────────────────────────────────────────────────

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

function registerWriteTool(pi: ExtensionAPI, service: LspService): void {
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
      await guardWriteAccess(ctx, {
        toolName: "write",
        absolutePath,
        change: { oldText: "", newText: content },
      });
      const dir = dirname(absolutePath);

      const throwIfAborted = () => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };

      const [message, details, diagnosticText] = await withFileMutationQueue(
        absolutePath,
        async () => {
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
          const diagnosticText = await service.lspDiagnosticsForFile(absolutePath, ctx.cwd);

          return ["Wrote file successfully.", undefined, diagnosticText] as const;
        },
      );

      const text = diagnosticText
        ? `${message}\n\nLSP errors detected in this file, please fix:\n${diagnosticText}`
        : message;
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export function registerFileTools(pi: ExtensionAPI, service: LspService): void {
  registerReadTool(pi, service);
  registerEditTool(pi, service);
  registerWriteTool(pi, service);
}

/** 独立入口：创建 LSP service（闭包共享给三个工具）并注册。 */
export default function opencodeFileTools(pi: ExtensionAPI): void {
  const service = createLspService();
  initLsp(pi, service);
  registerFileTools(pi, service);
}
