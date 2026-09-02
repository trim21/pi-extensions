import { createHash } from "node:crypto";
import { constants, readFileSync, type Stats } from "node:fs";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { appendLspDiagnosticText } from "../lib/lsp/diagnostic.js";
import { registerLspInspectTools } from "../lib/lsp/inspect-tool.js";
import { type LspService, registerLsp } from "../lib/lsp/lsp.js";
import { registerLspRenameTool } from "../lib/lsp/rename-tool.js";
import { formatSubtitlePath } from "../lib/path.js";
import type { ToolPendant } from "../lib/pendant.ts";
import { guardWriteAccess } from "../lib/write-guard.js";
import {
  type ClaudeCodeState,
  createClaudeCodeState,
  deserializeReads,
  didYouMean,
  type FileSnapshot,
  requireAbsolutePath,
  snapshotsEqual,
} from "./common.js";
import { convertLeadingTabsToSpaces, findActualString, preserveQuoteStyle } from "./edit-utils.js";

const SAMPLE_BYTES = 4096;

/** 同范围重复读取、文件未变时返回的 stub（对齐 Claude Code 的 file_unchanged）。 */
export const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";

/** Read 全读时的文件大小上限（对齐 Claude Code 的 256KB）。 */
const MAX_READ_SIZE_BYTES = 0.25 * 1024 * 1024;
/** Read 输出 token 粗估上限（对齐 Claude Code 的 25K tokens；无 tokenizer，按 4 字符/token 估算）。 */
const MAX_READ_TOKENS = 25_000;

/** Edit 最大文件大小（stat 字节数），防止大文件 OOM（对齐 Claude Code）。 */
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

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
  /**
   * 本轮受影响文件的已读快照（path → snapshot）。随工具结果持久化到
   * session 文件，resume 后由 session_start 重建 reads state。
   */
  reads?: Record<string, FileSnapshot>;
}

function snapshotOf(content: Uint8Array | string, textEditable = true): FileSnapshot {
  return { digest: createHash("sha256").update(content).digest("hex"), textEditable };
}

async function assertReadableFile(filePath: string): Promise<Stats> {
  const value = await stat(filePath);
  if (value.isDirectory()) {
    throw new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`);
  }
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

/**
 * 对齐 Claude Code 的 readFileInRange + addLineNumbers：
 * - 剥离 UTF-8 BOM；
 * - 非空文件按「每行 + 一个尾随空行」切分（真实 CC 的尾部 fragment 无条件
 *   加入，等价于补一个 \n 再 split），所以 totalLines 总比编辑器显示行数多 1；
 * - 每行去掉尾随 \r（CRLF → LF）。
 */
function splitFileLines(content: string): string[] {
  const text = content.replace(/^\uFEFF/, "");
  if (text === "") return [];
  return (text.endsWith("\n") ? text : `${text}\n`)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * 格式化读取输出：行号前缀用 `N: `（对齐 opencode Read）。弃用 Claude Code
 * 的 `N\t` 前缀——tab 分隔符在 Go 等 tab 缩进语言里会与内容缩进连排，模型
 * 易误判多一层缩进。limit 未指定时读取全部。无 PARTIAL 提示、无单行截断
 * （由 execute 层的字节/token 上限兜底）。
 */
export function formatReadOutput(
  content: string,
  offset = 1,
  limit?: number,
): { text: string; totalLines: number } {
  const lines = splitFileLines(content);
  const totalLines = lines.length;
  if (totalLines === 0) {
    return {
      text: "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
      totalLines,
    };
  }
  if (offset > totalLines) {
    return {
      text: `<system-reminder>Warning: the file exists but is shorter than the provided offset (${offset}). The file has ${totalLines} lines.</system-reminder>`,
      totalLines,
    };
  }
  // offset=0 时从第一行开始、行号从 0 起（对齐 Claude Code 的 lineOffset 语义）
  const startIndex = offset === 0 ? 0 : offset - 1;
  const selected =
    limit === undefined ? lines.slice(startIndex) : lines.slice(startIndex, startIndex + limit);
  const text = selected.map((line, index) => `${offset + index}: ${line}`).join("\n");
  return { text, totalLines };
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

/**
 * reads 记账 key：解析 symlink 后的真实路径，与 withFileMutationQueue 的队列
 * key 对齐。文件尚不存在（Write 新建 / Edit 空 old_string 创建）时 realpath
 * 抛 ENOENT，回退到已规范化路径。
 */
async function readStateKey(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return filePath;
    }
    throw error;
  }
}

/**
 * 校验「已读且未变」。key 与 currentContent 由调用方提供：调用方每次工具调用
 * 只 realpath / readFile 一次，避免重复 IO。
 */
function requireCurrentRead(
  state: ClaudeCodeState,
  key: string,
  filePath: string,
  currentContent: Uint8Array,
): void {
  const readSnapshot = state.reads.get(key);
  if (!readSnapshot) {
    throw new Error("File has not been read yet. Read it first before writing to it.");
  }
  if (!readSnapshot.textEditable) {
    throw new Error(`Cannot edit or overwrite a binary file with a text tool: ${filePath}`);
  }
  if (!snapshotsEqual(readSnapshot, snapshotOf(currentContent))) {
    throw new Error(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
  }
}

export function registerFileTools(
  pi: ExtensionAPI,
  state: ClaudeCodeState,
  service: LspService,
): void {
  pi.registerTool({
    name: "Read",
    label: "Read",
    description: [
      "Reads a file from the local filesystem. You can access any file directly using this tool.",
      "Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.",
      "The file_path parameter must be an absolute path. By default, it reads the entire file; files over 256 KB or 25K tokens require offset and limit.",
      "Results use cat -n style line numbers starting at 1. Images are returned visually.",
      "This tool reads files, not directories.",
    ].join("\n"),
    promptSnippet: "Read files from the local filesystem with line numbers",
    promptGuidelines: [READ_PROMPT],
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const filePath = requireAbsolutePath(params.file_path);
      if (
        params.offset !== undefined &&
        (!Number.isSafeInteger(params.offset) || params.offset < 0)
      ) {
        throw new Error("offset must be a non-negative integer");
      }
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
        throw new Error("limit must be a positive integer");
      }
      // 文件不存在 → 友好错误 + Did you mean（对齐 Claude Code）
      try {
        await assertReadableFile(filePath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          const suggestion = await didYouMean(filePath, ctx.cwd);
          throw new Error(
            `File does not exist. Note: your current working directory is ${ctx.cwd}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
            { cause: error },
          );
        }
        throw error;
      }
      signal?.throwIfAborted();

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
        const snapshot = snapshotOf(image, false);
        const key = await readStateKey(filePath);
        state.reads.set(key, snapshot);
        return {
          content,
          details: {
            reads: { [key]: snapshot },
            pendant: {
              subtitle: formatSubtitlePath(ctx.cwd, filePath),
              title: "Read",
            } satisfies ToolPendant,
          },
        };
      }

      const offset = params.offset ?? 1;
      const limit = params.limit;
      const key = await readStateKey(filePath);
      const buffer = await readFile(filePath);

      // 同范围 + checksum 未变 → 返回 stub 而非重发内容（对齐 CC readFileState；
      // 复用 reads 里的 sha256，比 mtime 可靠，无时间片粒度问题）
      const previous = state.reads.get(key);
      if (
        previous !== undefined &&
        previous.offset !== undefined &&
        previous.offset === offset &&
        previous.limit === limit &&
        snapshotsEqual(previous, snapshotOf(buffer))
      ) {
        return {
          content: [{ type: "text", text: FILE_UNCHANGED_STUB }],
          details: { pendant: { subtitle: formatSubtitlePath(ctx.cwd, filePath) } },
        };
      }
      if (isBinary(buffer.subarray(0, SAMPLE_BYTES)))
        throw new Error(`Cannot read binary file: ${filePath}`);
      // 全读（limit 未传）时受字节上限约束（对齐 Claude Code）
      if (params.limit === undefined && buffer.length > MAX_READ_SIZE_BYTES) {
        throw new Error(
          `File content (${formatFileSize(buffer.length)}) exceeds maximum allowed size (${formatFileSize(MAX_READ_SIZE_BYTES)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
        );
      }
      const text = buffer.toString("utf8");
      const formatted = formatReadOutput(text, offset, limit);
      // 输出 token 粗估上限（无 tokenizer，4 字符/token），对读取范围生效
      const estimatedTokens = Math.ceil(formatted.text.length / 4);
      if (estimatedTokens > MAX_READ_TOKENS) {
        throw new Error(
          `File content (${estimatedTokens} tokens) exceeds maximum allowed tokens (${MAX_READ_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
        );
      }
      const snapshot = { ...snapshotOf(buffer), offset, limit };
      state.reads.set(key, snapshot);
      // LSP 文件事件通知是后台任务，失败不影响读取（read 不驻留文档）
      void service.notifyFile(filePath, ctx.cwd).catch(() => {
        // 后台通知失败不影响读取
      });
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          reads: { [key]: snapshot },
          pendant: {
            subtitle: formatSubtitlePath(ctx.cwd, filePath),
            title: "Read",
          } satisfies ToolPendant,
        },
      };
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
    promptGuidelines: [EDIT_PROMPT],
    parameters: Type.Object(
      {
        file_path: Type.String({ description: "The absolute path to the file to modify" }),
        old_string: Type.String({ description: "The text to replace" }),
        new_string: Type.String({
          description: "The text to replace it with (must be different from old_string)",
        }),
        replace_all: Type.Optional(
          Type.Boolean({ description: "Replace all occurrences of old_string", default: false }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
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
      const [message, details, diagnosticText, errorCount, warningCount] =
        await withFileMutationQueue<[string, FileToolDetails, string, number, number]>(
          filePath,
          async () => {
            const oldString = params.old_string;
            const newString = params.new_string;
            if (oldString === newString) {
              throw new Error(
                "No changes to make: old_string and new_string are exactly the same.",
              );
            }
            // 空 old_string：创建新文件或填充空文件（不需要先 Read，对齐 Claude Code）
            if (oldString === "") {
              let exists = true;
              try {
                const value = await stat(filePath);
                if (value.isFile()) {
                  const content = await readFile(filePath, "utf8");
                  if (content.trim() !== "") {
                    throw new Error("Cannot create new file - file already exists.");
                  }
                }
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                  exists = false;
                } else {
                  throw error;
                }
              }
              if (!exists) await mkdir(dirname(filePath), { recursive: true });
              await writeFile(filePath, newString, "utf8");
              const snapshot = snapshotOf(newString);
              const key = await readStateKey(filePath);
              state.reads.set(key, snapshot);
              const diff = generateDiffString("", convertLeadingTabsToSpaces(newString));
              signal?.throwIfAborted();
              const {
                text: diagnosticText,
                errorCount,
                warningCount,
              } = await service.lspDiagnosticsForFile(filePath, ctx.cwd, {
                notify: (message, level) => ctx.ui.notify(message, level),
                signal,
              });
              return [
                `The file ${filePath} has been updated successfully.`,
                {
                  diff: diff.diff,
                  patch: generateUnifiedPatch(filePath, "", convertLeadingTabsToSpaces(newString)),
                  firstChangedLine: diff.firstChangedLine,
                  reads: { [key]: snapshot },
                },
                diagnosticText,
                errorCount,
                warningCount,
              ];
            }
            const replaceAll = params.replace_all ?? false;
            // 防止 OOM 的大文件检查（对齐 Claude Code）
            try {
              const { size } = await stat(filePath);
              if (size > MAX_EDIT_FILE_SIZE) {
                throw new Error(
                  `File is too large to edit (${formatFileSize(size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
                );
              }
            } catch (error) {
              if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
                throw error;
              }
            }
            let content: Buffer;
            try {
              content = await readFile(filePath);
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                const suggestion = await didYouMean(filePath, ctx.cwd);
                throw new Error(
                  `File does not exist. Note: your current working directory is ${ctx.cwd}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
                  { cause: error },
                );
              }
              throw error;
            }
            if (extname(filePath).toLowerCase() === ".ipynb") {
              throw new Error(
                "File is a Jupyter Notebook. Use the NotebookEditTool to edit this file.",
              );
            }
            const key = await readStateKey(filePath);
            requireCurrentRead(state, key, filePath, content);
            await access(filePath, constants.R_OK | constants.W_OK);
            signal?.throwIfAborted();
            const original = content.toString("utf8");

            // CRLF 规范化后匹配（old_string 不需要带 \r），写回时恢复原行尾
            const crlfCount = (original.match(/\r\n/g) ?? []).length;
            const lfCount = (original.match(/(?<!\r)\n/g) ?? []).length;
            const lineEnding = crlfCount > lfCount ? "\r\n" : "\n";
            const normalized = original.replaceAll("\r\n", "\n");
            const actualOldString = findActualString(normalized, oldString) ?? oldString;
            const matches = normalized.split(actualOldString).length - 1;
            if (matches === 0) {
              throw new Error(`String to replace not found in file.\nString: ${oldString}`);
            }
            if (!replaceAll && matches > 1) {
              throw new Error(
                `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`,
              );
            }
            const actualNewString = preserveQuoteStyle(oldString, actualOldString, newString);
            // 删除场景（new_string 为空）：old_string 不以换行结尾且文件里是
            // "old_string\n" 时连换行一起删，避免留下空行（对齐 Claude Code
            // applyEditToFile 的 stripTrailingNewline 语义）
            let searchString = actualOldString;
            if (
              actualNewString === "" &&
              !actualOldString.endsWith("\n") &&
              normalized.includes(actualOldString + "\n")
            ) {
              searchString = actualOldString + "\n";
            }
            // split/join 与函数替换：replacement 含 $ 时不会触发 $& 等特殊语义
            const updated = replaceAll
              ? normalized.split(searchString).join(actualNewString)
              : normalized.replace(searchString, () => actualNewString);
            const restored = lineEnding === "\r\n" ? updated.replaceAll("\n", "\r\n") : updated;
            await writeFile(filePath, restored, "utf8");
            const snapshot = snapshotOf(restored);
            state.reads.set(key, snapshot);
            // patch/diff 仅供显示：前导 tab 转空格，避免 UI 渲染错位（对齐 Claude Code）
            const diff = generateDiffString(
              convertLeadingTabsToSpaces(original),
              convertLeadingTabsToSpaces(restored),
            );
            const text = replaceAll
              ? `The file ${filePath} has been updated. All occurrences were successfully replaced.`
              : `The file ${filePath} has been updated successfully.`;
            signal?.throwIfAborted();
            const {
              text: diagnosticText,
              errorCount,
              warningCount,
            } = await service.lspDiagnosticsForFile(filePath, ctx.cwd, {
              notify: (message, level) => ctx.ui.notify(message, level),
            });
            return [
              text,
              {
                diff: diff.diff,
                patch: generateUnifiedPatch(
                  filePath,
                  convertLeadingTabsToSpaces(original),
                  convertLeadingTabsToSpaces(restored),
                ),
                firstChangedLine: diff.firstChangedLine,
                reads: { [key]: snapshot },
              },
              diagnosticText,
              errorCount,
              warningCount,
            ];
          },
        );

      const text = appendLspDiagnosticText(message, diagnosticText, errorCount);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          ...details,
          pendant: {
            subtitle: formatSubtitlePath(ctx.cwd, filePath, errorCount, warningCount),
            title: "Edit",
          } satisfies ToolPendant,
        },
      };
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
    promptGuidelines: [WRITE_PROMPT],
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
      signal?.throwIfAborted();
      const filePath = requireAbsolutePath(params.file_path);
      await guardWriteAccess(ctx, {
        toolName: "Write",
        absolutePath: filePath,
        change: { oldText: "", newText: params.content },
      });
      const [message, details, diagnosticText, errorCount, warningCount] =
        await withFileMutationQueue<[string, FileToolDetails, string, number, number]>(
          filePath,
          async () => {
            let original: string | undefined;
            let key: string | undefined;
            try {
              const value = await stat(filePath);
              if (value.isFile()) {
                const content = await readFile(filePath);
                key = await readStateKey(filePath);
                requireCurrentRead(state, key, filePath, content);
                original = content.toString("utf8");
              }
            } catch (error) {
              if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
                throw error;
              }
            }
            signal?.throwIfAborted();
            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, params.content, "utf8");
            const snapshot = snapshotOf(params.content);
            // 新建文件：writeFile 之后 realpath 才能解析；覆盖写则复用上面的 key
            const resolvedKey = key ?? (await readStateKey(filePath));
            state.reads.set(resolvedKey, snapshot);
            const diff = generateDiffString(original ?? "", params.content);
            const text =
              original === undefined
                ? `File created successfully at: ${filePath}`
                : `The file ${filePath} has been updated successfully.`;
            signal?.throwIfAborted();
            const {
              text: diagnosticText,
              errorCount,
              warningCount,
            } = await service.lspDiagnosticsForFile(filePath, ctx.cwd, {
              notify: (message, level) => ctx.ui.notify(message, level),
            });
            return [
              text,
              {
                diff: diff.diff,
                patch: generateUnifiedPatch(filePath, original ?? "", params.content),
                firstChangedLine: diff.firstChangedLine,
                reads: { [resolvedKey]: snapshot },
              },
              diagnosticText,
              errorCount,
              warningCount,
            ];
          },
        );

      const text = appendLspDiagnosticText(message, diagnosticText, errorCount);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          ...details,
          pendant: { subtitle: formatSubtitlePath(ctx.cwd, filePath, errorCount, warningCount) },
        },
      };
    },
  });

  // lsp-rename 工具壳与 opencode 共享（lib/lsp/rename-tool.ts）；本工具集
  // 跟踪 read-before-write 状态，rename 落盘的文件要标记为已读并随 details
  // 持久化（FILE_TOOL_NAMES 的 restoreFileReads 依赖 details.reads）。
  registerLspRenameTool(pi, service, {
    recordReads: async (applied) => {
      const reads: Record<string, FileSnapshot> = {};
      for (const fileEdit of applied) {
        const key = await readStateKey(fileEdit.path);
        const snapshot = snapshotOf(fileEdit.newText);
        state.reads.set(key, snapshot);
        reads[key] = snapshot;
      }
      return reads;
    },
  });
  // 只读符号查询工具（find-definition / find-reference / inspect）与 opencode 共享。
  registerLspInspectTools(pi, service);
}

/** 会更新 reads state 并随 details 持久化快照的工具名。 */
const FILE_TOOL_NAMES = new Set(["Read", "Edit", "Write", "lsp-rename"]);

/**
 * 从当前分支的历史工具结果重建已读记账。先清空再重放，保证 state 只反映
 * 当前分支：rewind / fork / resume 后，被抛弃分支上的 Read 不再残留。
 */
function restoreFileReads(
  state: ClaudeCodeState,
  sessionManager: ExtensionContext["sessionManager"],
): void {
  state.reads.clear();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (!FILE_TOOL_NAMES.has(entry.message.toolName)) continue;
    const details = entry.message.details as { reads?: unknown } | undefined;
    if (!details?.reads) continue;
    for (const [filePath, snapshot] of deserializeReads(details.reads)) {
      state.reads.set(filePath, snapshot);
    }
  }
}

/**
 * 独立扩展入口：files.ts 可单独经 `-e claude-code/files.ts` 加载（spawn-agent
 * 子代理把 Read/Edit/Write 工具名映射到本文件），无需经 index.ts。reads
 * state 归本文件所有：扩展实例内创建，并随 session 事件从历史分支恢复，
 * 与主进程 index.ts 聚合加载时的行为一致。
 */
export default function claudeCodeFileTools(pi: ExtensionAPI): void {
  const service = registerLsp(pi);
  const state = createClaudeCodeState();

  // 扩展实例在进程启动 / /reload / /new / /resume / /fork 时重建，内存里的
  // 已读记账随之丢失。这里从当前分支的历史工具结果里恢复：digest 是当时的值，
  // 若文件在此期间被外部修改，Edit/Write 时的指纹对比仍会要求重新 Read，
  // 防呆语义不因重建而弱化。
  pi.on("session_start", (_event, ctx) => {
    restoreFileReads(state, ctx.sessionManager);
  });

  // rewind / 树内跳转走 navigateTree → branch()，只发 session_tree 不发
  // session_start，扩展实例也不重建。这里同样重放当前分支，丢弃被抛弃分支
  // 的记账，避免 state 与当前分支脱节。
  pi.on("session_tree", (_event, ctx) => {
    restoreFileReads(state, ctx.sessionManager);
  });

  registerFileTools(pi, state, service);
}
