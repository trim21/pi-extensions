/**
 * LSP WorkspaceEdit 应用与 rename 定位辅助。
 *
 * - expandWorkspaceEdit：把 rename 返回的 WorkspaceEdit 展开成每文件的
 *   old/new 文本（纯内存计算，写盘由调用方决定时机与方式）；
 * - lineCandidates：character 缺省时在一行内按词边界枚举候选位置，
 *   供逐候选探测消歧；
 * - canonicalizeEdit：把两次 rename 的结果归一化成稳定字符串，
 *   比较它们是否指向同一个符号（同名歧义消解）。
 *
 * 位置语义按 LSP 规范：0-based 行列，character 为 UTF-16 code unit，
 * 行内容不含行结束符（CRLF 的 \r 不计入列号）。
 */

import { normalize } from "node:path";
import { fileURLToPath } from "node:url";

import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-types";

/** 单个文件展开后的编辑结果。 */
export interface AppliedFileEdit {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly changeCount: number;
}

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

/** 应用层只关心 range + newText（TextDocumentEdit 的编辑联合的公共形状）。 */
interface RangeLike {
  readonly range: { readonly start: LspPosition; readonly end: LspPosition };
  readonly newText: string;
}

/** 编辑联合里 SnippetTextEdit 没有 newText，应用层不支持且无法静默处理。 */
function isRangeLike(edit: unknown): edit is RangeLike {
  return (
    typeof edit === "object" &&
    edit !== null &&
    "range" in edit &&
    "newText" in edit &&
    typeof (edit as { newText: unknown }).newText === "string"
  );
}

/** file:// URI → 规范化本地路径；非 file scheme 是服务器的意外行为，直接报错。 */
function toPath(uri: string): string {
  if (!uri.startsWith("file:")) {
    throw new Error(`lsp-rename: unsupported uri scheme: ${uri}`);
  }
  return normalize(fileURLToPath(uri));
}

/** 每行起始偏移（含第 0 行的 0）；换行符是 \n，\r 属于行内容之外由调用侧处理。 */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.codePointAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 行内容长度（不含行结束符，CRLF 时连 \r 一起排除）。 */
function lineContentLength(text: string, starts: readonly number[], line: number): number {
  const base = starts[line];
  let end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  if (end > base && text.codePointAt(end - 1) === 13) end--;
  return end - base;
}

/**
 * position → 字符串偏移。character 超出行长视为服务器返回了非法位置，
 * 抛错而不是静默钳制（避免把编辑应用到错误位置）。
 */
function positionToOffset(
  text: string,
  starts: readonly number[],
  position: LspPosition,
  path: string,
): number {
  if (position.line < 0 || position.line >= starts.length) {
    throw new Error(
      `lsp-rename: edit position out of range in ${path} (line ${position.line + 1})`,
    );
  }
  const base = starts[position.line];
  const length = lineContentLength(text, starts, position.line);
  if (position.character < 0 || position.character > length) {
    throw new Error(
      `lsp-rename: edit position out of range in ${path} (character ${position.character + 1} on line ${position.line + 1})`,
    );
  }
  return base + position.character;
}

/** 按起始位置降序应用（后文先改，避免前文编辑使后续偏移失效）。 */
function applyTextEdits(path: string, text: string, edits: readonly RangeLike[]): string {
  const starts = lineStartOffsets(text);
  let result = text;
  const sorted = edits.toSorted(
    (a, b) =>
      b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character,
  );
  for (const edit of sorted) {
    const start = positionToOffset(text, starts, edit.range.start, path);
    const end = positionToOffset(text, starts, edit.range.end, path);
    if (end < start) {
      throw new Error(`lsp-rename: invalid edit range in ${path} (end before start)`);
    }
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

/** 把 changes 与 documentChanges 里的 text edit 按（规范化）路径收集；文件级操作报不支持。 */
function collectTextEdits(edit: WorkspaceEdit): Map<string, RangeLike[]> {
  const byPath = new Map<string, RangeLike[]>();
  const push = (path: string, edits: readonly RangeLike[]): void => {
    const existing = byPath.get(path);
    if (existing) existing.push(...edits);
    else byPath.set(path, [...edits]);
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    push(toPath(uri), edits.filter(isRangeLike));
  }
  for (const change of edit.documentChanges ?? []) {
    if ("kind" in change || !("textDocument" in change) || !("edits" in change)) {
      throw new Error(
        "lsp-rename: file-level document changes (create/rename/delete) are not supported",
      );
    }
    push(toPath(change.textDocument.uri), change.edits.filter(isRangeLike));
  }
  return byPath;
}

/**
 * 展开成每文件的新旧文本。readText 由调用方提供（工具层传磁盘读取），
 * 任一文件读取失败即整体失败，调用方可以安全地"全部算好再写盘"。
 */
export async function expandWorkspaceEdit(
  edit: WorkspaceEdit,
  readText: (path: string) => Promise<string>,
): Promise<AppliedFileEdit[]> {
  const applied: AppliedFileEdit[] = [];
  for (const [path, edits] of collectTextEdits(edit)) {
    const oldText = await readText(path);
    applied.push({
      path,
      oldText,
      newText: applyTextEdits(path, oldText, edits),
      changeCount: edits.length,
    });
  }
  return applied;
}

/**
 * rename edit 覆盖的文件路径集合（changes + documentChanges 的 text edits）。
 * 供 renameSymbol 用 references 结果做覆盖校验。
 */
export function editFilePaths(edit: WorkspaceEdit): Set<string> {
  return new Set(collectTextEdits(edit).keys());
}

/**
 * 归一化 WorkspaceEdit 为稳定字符串（URI → 规范路径、结构化字段），供比较
 * 两次 rename 的编辑集合是否一致（同一符号的多次出现 vs 不同符号）。
 */
export function canonicalizeEdit(edit: WorkspaceEdit): string {
  const changes: Record<string, TextEdit[]> = {};
  const documentChanges: unknown[] = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    changes[toPath(uri)] = edits;
  }
  for (const change of edit.documentChanges ?? []) {
    if ("kind" in change || !("textDocument" in change) || !("edits" in change)) {
      documentChanges.push(change);
      continue;
    }
    documentChanges.push({
      textDocument: { uri: toPath(change.textDocument.uri) },
      edits: change.edits,
    });
  }
  return JSON.stringify({ changes, documentChanges });
}

const WORD_PATTERN = /[\p{L}\p{N}_$]+/gu;

/**
 * 一行内 `symbol` 的候选位置（0-based，列相对行首）：
 * - `character` 缺省：枚举行内与 `symbol` 相同的词出现位置；
 * - `character` 给定：该列必须落在与 `symbol` 相同的词内（消歧时防改错目标），
 *   否则抛参数错误。
 * 该行找不到 `symbol` 时返回空数组。
 */
export function symbolCandidates(
  text: string,
  line: number,
  symbol: string,
  character?: number,
): LspPosition[] {
  const starts = lineStartOffsets(text);
  if (line < 0 || line >= starts.length) return [];
  const base = starts[line];
  const length = lineContentLength(text, starts, line);
  const matches = [...text.slice(base, base + length).matchAll(WORD_PATTERN)];
  if (character !== undefined) {
    const target = matches.find((match) => {
      const start = match.index;
      return character >= start && character < start + match[0].length;
    });
    if (!target || target[0] !== symbol) {
      const actual = target ? target[0] : "";
      throw new Error(
        `character ${character + 1} on line ${line + 1} does not point at symbol '${symbol}'` +
          (actual === "" ? "" : ` (points at '${actual}')`),
      );
    }
    return [{ line, character: target.index }];
  }
  const candidates: LspPosition[] = [];
  for (const match of matches) {
    if (match[0] === symbol) candidates.push({ line, character: match.index });
  }
  return candidates;
}
