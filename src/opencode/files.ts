/**
 * Opencode File Tools —— read / edit / write 统一构建点。
 *
 * read / edit / write 三个工具在同一个 registerFileTools(pi, service) 里注册，
 * 共享同一个 LSP service 实例（registerLsp 创建的闭包变量）；lsp-rename 的
 * 工具壳与 claude-code 共享，同样挂进 registerFileTools。
 *
 * 对齐官方 v1（packages/opencode/src/tool/{read,edit,write}.ts）：
 * - read：流式分行（LF / CRLF / CR）、每行 `N: ` 行号前缀、单行 2000
 *   字符截断、1 起始 offset、目录排序；读取后后台 LSP warm-up。
 *   不接 PDF、不接 <system-reminder>；图片 magic 检测保留。
 * - edit：匹配引擎 + 把 old/new 转到文件换行后再替换；写后等待文档诊断。
 * - write：BOM 保留（source.bom || next.bom）；写后同 edit 的诊断输出。
 *
 * 匹配引擎在 edit-engine.ts，也被 lib/write-guard 复用。
 */

import { constants, createReadStream } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { createInterface } from "node:readline";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { appendLspDiagnosticText } from "../lib/lsp/diagnostic.js";
import { registerLspInspectTools } from "../lib/lsp/inspect-tool.js";
import { createLspManager, type LspService, type LspServiceOptions } from "../lib/lsp/lsp.js";
import { registerLspRenameTool } from "../lib/lsp/rename-tool.js";
import { formatSubtitlePath } from "../lib/path.js";
import { guardWriteAccess } from "../lib/write-guard.js";
import { applyEdit, normalizeToLF, stripBom } from "./edit-engine.js";

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
        buf[28] === 1 &&
        [1, 4, 8, 16, 24, 32].includes(buf[28 + 1])
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

async function readSample(filePath: string): Promise<Uint8Array> {
  try {
    const fileHandle = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(SAMPLE_BYTES);
      const { bytesRead } = await fileHandle.read(buf, 0, SAMPLE_BYTES, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fileHandle.close();
    }
  } catch {
    return new Uint8Array();
  }
}

async function detectImageMimeTypeFromFile(filePath: string): Promise<string | null> {
  return detectImageMimeType(await readSample(filePath));
}

function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
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
  outputLines: number;
  outputBytes: number;
  offset: number;
}

export interface LinePage {
  raw: string[];
  count: number;
  cut: boolean;
  more: boolean;
  offset: number;
}

/**
 * Stream a text file the way opencode v1 ReadTool.lines does:
 * - readline with crlfDelay: Infinity (LF / CRLF / CR as one break)
 * - per-line truncation to MAX_LINE_LENGTH
 * - line cap via maxLines (more): keep scanning so count is the file total
 * - byte cap via maxBytes (cut): stop immediately
 */
export async function readLines(
  filePath: string,
  opts: { offset: number; limit: number; maxBytes?: number },
): Promise<LinePage> {
  const start = opts.offset - 1;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const raw: string[] = [];
  let count = 0;
  let bytes = 0;
  let cut = false;
  let more = false;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const text of rl) {
      count += 1;
      if (count <= start) continue;

      if (raw.length >= opts.limit) {
        more = true;
        continue;
      }

      const line =
        text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text;
      const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        cut = true;
        more = true;
        break;
      }
      raw.push(line);
      bytes += size;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { raw, count, cut, more, offset: opts.offset };
}

function truncationFromPage(page: LinePage): TruncationResult {
  const content = page.raw.join("\n");
  return {
    content,
    truncated: page.more || page.cut,
    truncatedBy: page.cut ? "bytes" : page.more ? "lines" : null,
    totalLines: page.count,
    outputLines: page.raw.length,
    outputBytes: Buffer.byteLength(content, "utf8"),
    offset: page.offset,
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

function registerReadTool(pi: ExtensionAPI, getService: () => LspService): void {
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
      signal?.throwIfAborted();

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
          details: { pendant: { subtitle: formatSubtitlePath(ctx.cwd, absolutePath) } },
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
        return {
          content,
          details: { pendant: { subtitle: formatSubtitlePath(ctx.cwd, absolutePath) } },
        };
      }

      if (isBinaryExtension(absolutePath) || isBinaryFileBySample(await readSample(absolutePath))) {
        return {
          content: [{ type: "text", text: `Cannot read binary file: ${absolutePath}` }],
          details: undefined,
        };
      }

      const effectiveOffset = offset || 1;
      const page = await readLines(absolutePath, {
        offset: effectiveOffset,
        limit: limit ?? DEFAULT_MAX_LINES,
      });

      if (page.count < page.offset && !(page.count === 0 && page.offset === 1)) {
        throw new Error(
          `Offset ${page.offset} is out of range for this file (${page.count} lines)`,
        );
      }

      const last = page.offset + page.raw.length - 1;
      const next = last + 1;
      const numbered = page.raw.map((line, i) => `${i + page.offset}: ${line}`).join("\n");
      const header = `<path>${absolutePath}</path>\n<type>file</type>\n<content>\n`;
      const footer = "\n</content>";

      let outputText: string;
      let details: { truncation?: TruncationResult } | undefined;
      if (page.cut) {
        outputText = `${header}${numbered}\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${page.offset}-${last}. Use offset=${next} to continue.)${footer}`;
        details = { truncation: truncationFromPage(page) };
      } else if (page.more) {
        outputText = `${header}${numbered}\n\n(Showing lines ${page.offset}-${last} of ${page.count}. Use offset=${next} to continue.)${footer}`;
        details = { truncation: truncationFromPage(page) };
      } else {
        outputText = `${header}${numbered}\n\n(End of file - total ${page.count} lines)${footer}`;
      }

      content = [{ type: "text", text: outputText }];

      // opencode: LSP 文件事件通知是后台任务，失败不影响读取（read 不驻留文档）
      void getService()
        .notifyFile(absolutePath, ctx.cwd)
        .catch(() => {
          // 后台通知失败不影响读取
        });

      return {
        content,
        details: {
          ...details,
          pendant: { subtitle: formatSubtitlePath(ctx.cwd, absolutePath) },
        },
      };
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

function registerEditTool(pi: ExtensionAPI, getService: () => LspService): void {
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

      const [message, details, diagnosticText, errorCount, warningCount] =
        await withFileMutationQueue(absolutePath, async () => {
          signal?.throwIfAborted();

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
            if (exists) {
              throw new Error(
                "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
              );
            }
            // opencode: writeWithDirs 自动创建父目录；newString 开头的 BOM 原样保留
            await mkdir(dirname(absolutePath), { recursive: true });
            signal?.throwIfAborted();
            await writeFile(absolutePath, newString, "utf8");
            const {
              text: diagnosticText,
              errorCount,
              warningCount,
            } = await getService().lspDiagnosticsForFile(absolutePath, ctx.cwd, { signal });
            return [
              "Edit applied successfully.",
              { diff: "", patch: "", firstChangedLine: 0 },
              diagnosticText,
              errorCount,
              warningCount,
            ] as const;
          }

          let fileStat: Awaited<ReturnType<typeof stat>>;
          try {
            fileStat = await stat(absolutePath);
          } catch {
            throw new Error(`File ${absolutePath} not found`);
          }
          if (fileStat.isDirectory()) {
            throw new Error(`Path is a directory, not a file: ${absolutePath}`);
          }
          try {
            await access(absolutePath, constants.R_OK | constants.W_OK);
          } catch (error: unknown) {
            const msg =
              error instanceof Error && "code" in error && typeof error.code === "string"
                ? `Error code: ${error.code}`
                : String(error);
            throw new Error(`Could not edit file: ${filePath}. ${msg}.`, { cause: error });
          }

          const rawContent = await readFile(absolutePath, "utf8");
          const applied = applyEdit(rawContent, oldString, newString, replaceAll);
          signal?.throwIfAborted();
          await writeFile(absolutePath, applied.finalContent, "utf8");

          const diffOld = normalizeToLF(applied.contentOld);
          const diffNew = normalizeToLF(applied.contentNew);
          const diffResult = generateDiffString(diffOld, diffNew);
          const patch = generateUnifiedPatch(filePath, diffOld, diffNew);
          const {
            text: diagnosticText,
            errorCount,
            warningCount,
          } = await getService().lspDiagnosticsForFile(absolutePath, ctx.cwd, { signal });
          return [
            "Edit applied successfully.",
            { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
            diagnosticText,
            errorCount,
            warningCount,
          ] as const;
        });

      const text = appendLspDiagnosticText(message, diagnosticText, errorCount);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          ...details,
          pendant: {
            subtitle: formatSubtitlePath(ctx.cwd, absolutePath, errorCount, warningCount),
          },
        },
      };
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

function registerWriteTool(pi: ExtensionAPI, getService: () => LspService): void {
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

      const [message, details, diagnosticText, errorCount, warningCount] =
        await withFileMutationQueue(absolutePath, async () => {
          signal?.throwIfAborted();

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
          const { bom: desiredBom, text: nextText } = resolveBom(existing, content);

          await mkdir(dir, { recursive: true });
          signal?.throwIfAborted();
          await writeFile(absolutePath, desiredBom + nextText, "utf8");
          const {
            text: diagnosticText,
            errorCount,
            warningCount,
          } = await getService().lspDiagnosticsForFile(absolutePath, ctx.cwd, { signal });

          return [
            "Wrote file successfully.",
            {},
            diagnosticText,
            errorCount,
            warningCount,
          ] as const;
        });

      const text = appendLspDiagnosticText(message, diagnosticText, errorCount);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          ...details,
          pendant: {
            subtitle: formatSubtitlePath(ctx.cwd, absolutePath, errorCount, warningCount),
          },
        },
      };
    },
  });
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export function registerFileTools(pi: ExtensionAPI, getService: () => LspService): void {
  registerReadTool(pi, getService);
  registerEditTool(pi, getService);
  registerWriteTool(pi, getService);
  // lsp-rename / inspect 工具由 manager 的 onEnabled 回调注册，不在这里注册。
}

/** 独立入口：创建 LSP manager（session_start 时按配置启用）并注册文件工具。 */
export default function opencodeFileTools(pi: ExtensionAPI, options?: LspServiceOptions): void {
  const manager = createLspManager(
    pi,
    {
      onEnabled: (pi, service) => {
        registerLspRenameTool(pi, service);
        registerLspInspectTools(pi, service);
      },
    },
    options,
  );
  // 文件工具无条件注册；service 惰性获取，disabled 时为 no-op。
  registerFileTools(pi, () => manager.mustLazyGetService());
}
