/**
 * LSP WorkspaceEdit 应用与 rename 定位辅助。
 *
 * - expandWorkspaceEdit：把 rename 返回的 WorkspaceEdit 展开成每文件的
 *   old/new 文本（纯内存计算，写盘由调用方决定时机与方式）；
 * - lineCandidates：character 缺省时在一行内按词边界枚举候选位置，
 *   供逐候选探测消歧；
 * - canonicalizeEdit：把两次 rename 的结果归一化成稳定字符串，
 *   比较它们是否指向同一个符号（同名歧义消解）；
 * - verifyRenameCoverage：等 references 的稳定窗口收敛，再双向校验 rename edit
 *   的覆盖（missing / extra），不满足时抛 RenameIncompleteError。
 *
 * 位置语义按 LSP 规范：0-based 行列，character 为 UTF-16 code unit，
 * 行内容不含行结束符（CRLF 的 \r 不计入列号）。
 */

import { normalize } from "node:path";
import { fileURLToPath } from "node:url";

import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-types";

import { isRecord } from "../narrow.js";

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
  return isRecord(edit) && "range" in edit && "newText" in edit && typeof edit.newText === "string";
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
    if (text.codePointAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 行内容长度（不含行结束符，CRLF 时连 \r 一起排除）。 */
function lineContentLength(text: string, starts: readonly number[], line: number): number {
  const base = starts[line];
  let end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  if (end > base && text.codePointAt(end - 1) === 13) {
    end--;
  }
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
    if (existing) {
      existing.push(...edits);
    } else {
      byPath.set(path, [...edits]);
    }
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

/** 两个路径集合是否一致（用于判断 references 结果是否收敛）。 */
function samePathSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const path of a) {
    if (!b.has(path)) {
      return false;
    }
  }
  return true;
}

/** references 文件集合的稳定窗口：连续一致的采样累加计数，集合变化即重启窗口。 */
export interface StabilityRun {
  /** 本窗口采样到的文件集合（与后续采样比较用）。 */
  readonly paths: ReadonlySet<string>;
  /** 窗口起始时间戳（ms，最后一次集合变化的时刻）。 */
  readonly since: number;
  /** 窗口内连续一致的采样次数（≥1）。 */
  readonly samples: number;
}

/**
 * 用一次新的采样推进稳定窗口。服务器项目加载期间 references 只覆盖已发现
 * 的文件，残缺答案可以连续多次一致——「两次一致」不等于「索引收敛」，所以
 * 窗口还要持续足够时长（见 stabilityAcceptable）。
 */
export function trackStability(input: {
  previous: StabilityRun | undefined;
  paths: ReadonlySet<string>;
  now: number;
}): StabilityRun {
  const { previous, paths, now } = input;
  if (previous !== undefined && samePathSet(previous.paths, paths)) {
    return { paths, since: previous.since, samples: previous.samples + 1 };
  }
  return { paths, since: now, samples: 1 };
}

/** 稳定窗口是否达到可接受的稳定度：连续 minSamples 次一致，且集合已持续一致 minStableMs 毫秒。 */
export function stabilityAcceptable(
  run: StabilityRun,
  input: { now: number; minSamples: number; minStableMs: number },
): boolean {
  return run.samples >= input.minSamples && input.now - run.since >= input.minStableMs;
}

/**
 * rename edit 未覆盖 references 看到的全部文件：服务器索引可能仍在后台加载。
 * 抛出时发生在写盘之前，整个 rename 无副作用，可稍后重试。
 */
export class RenameIncompleteError extends Error {
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  constructor(missing: readonly string[], extra: readonly string[] = []) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(
        `textDocument/references found the symbol in ${missing.length} file(s) ` +
          `that the rename edit does not cover (${missing.join(", ")})`,
      );
    }
    if (extra.length > 0) {
      parts.push(
        `the rename edit touches ${extra.length} file(s) ` +
          `that textDocument/references did not report (${extra.join(", ")})`,
      );
    }
    if (parts.length === 0) {
      parts.push("the references result has not been stable long enough to trust");
    }
    super(
      `LSP rename incomplete: ${parts.join("; ")}. ` +
        `The server index may still be loading; nothing was modified, retry shortly.`,
    );
    this.missing = missing;
    this.extra = extra;
  }
}

/**
 * rename 覆盖校验的轮询节奏。budgetMs 是 references 收敛 + 重试的总预算；
 * 缺省见 DEFAULT_RENAME_VERIFICATION_TIMING，client 与测试按需覆盖。
 */
export interface RenameVerificationTiming {
  pollMs: number;
  budgetMs: number;
  /** ContentModified(-32801) 重试上限：服务器处理期间文档被修改，重发请求即可。 */
  contentModifiedRetries: number;
  /** 接受结果所需的最少连续一致采样次数。 */
  settleSamples: number;
  /** 就绪已证实（拿到过当前版本的诊断结论）时的稳定窗口下限（ms）。 */
  stableFloorReadyMs: number;
  /**
   * 就绪未证实（栅栏只是等满预算放行）时的稳定窗口下限（ms）。服务器加载
   * 项目期间 references 只覆盖已发现的文件，残缺答案能连续多次一致（假稳定），
   * 短窗口会把它误判成最终结果——CI 实测漏改跨文件引用，故要求 references
   * 文件集合至少持续一致这么久才接受。
   */
  stableFloorUnreadyMs: number;
}

/** rename 覆盖校验的缺省节奏（每个 client 可用创建参数局部覆盖）。 */
export const DEFAULT_RENAME_VERIFICATION_TIMING: RenameVerificationTiming = {
  pollMs: 400,
  budgetMs: 15_000,
  contentModifiedRetries: 3,
  settleSamples: 3,
  stableFloorReadyMs: 400,
  stableFloorUnreadyMs: 4_000,
};

/** verifyRenameCoverage 的输入：依赖全部注入，收敛序列与预算可直接构造。 */
export interface RenameCoverageOptions {
  /** 就绪栅栏：是否已证实拿到当前版本的诊断结论（决定稳定窗口下限）。 */
  indexReady: boolean;
  timing: RenameVerificationTiming;
  /** 进入校验前已采到的那一份 references 文件集合。 */
  initialPaths: ReadonlySet<string>;
  /** 后续采样：再请求一次 references 并给出文件集合。 */
  refetchPaths: () => Promise<ReadonlySet<string>>;
  /** 发一次 rename；返回 null 表示服务器拒绝重命名。 */
  sendRename: () => Promise<WorkspaceEdit | null>;
  /** 等待一次轮询间隔。 */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 当前时间戳（ms）。 */
  now: () => number;
  /** 构造「该位置不可重命名」错误：消息含 serverID 与位置，由调用方提供。 */
  notRenameable: () => Error;
  signal?: AbortSignal;
}

/**
 * 等 references 收敛并双向校验 rename 覆盖，返回 edit；不满足覆盖要求时抛
 * RenameIncompleteError。
 *
 * references 前置 + rename 双向校验：LSP 没有标准化的"索引完成"信号，
 * 服务器（如 tsserver）可能在项目加载完成前回答，导致 rename 漏掉
 * 尚未入索引的文件。对策分三层：
 * 1. 稳定窗口：references 文件集合连续 settleSamples 次一致、且持续
 *    一致超过稳定下限（就绪未证实用长窗口）才认为收敛，防止"服务器
 *    根本还没发现某文件"时残缺答案的假稳定被误判为最终结果；
 * 2. 覆盖校验（missing）：references 报告的文件必须都被 rename edit
 *    覆盖，缺失说明服务器索引落后，抛 RenameIncompleteError；
 * 3. 一致性校验（extra）：rename 触及的文件超出已收敛的 references
 *    集合，说明两次请求之间项目覆盖在增长（rename 晚于 references，
 *    索引仍在加载），此时 rename 的结果本身不可信——回到 references
 *    轮询等重新收敛，再重发 rename 复检；预算耗尽仍不一致时抛
 *    RenameIncompleteError——调用方尚未写盘，整个操作无副作用。
 *
 * 首次采样由调用方发起（initialPaths），本函数只负责后续的 refetchPaths
 * 采样，所以请求次数与调用方内联轮询时逐次一致；服务器不支持
 * references（MethodNotFound）时由调用方跳过本校验，信任服务器。
 *
 * 判定顺序是行为的一部分：双向一致但稳定窗口未达标时抛的是
 * RenameIncompleteError([], [])（残缺答案假稳定），而非带上 missing 的错误。
 */
export async function verifyRenameCoverage(options: RenameCoverageOptions): Promise<WorkspaceEdit> {
  const {
    indexReady,
    timing,
    initialPaths,
    refetchPaths,
    sendRename,
    sleep,
    now,
    notRenameable,
    signal,
  } = options;
  const minStableMs = indexReady ? timing.stableFloorReadyMs : timing.stableFloorUnreadyMs;
  const deadline = now() + timing.budgetMs;
  let stability = trackStability({ previous: undefined, paths: initialPaths, now: now() });
  for (;;) {
    signal?.throwIfAborted();
    const at = now();
    const stable = stabilityAcceptable(stability, {
      now: at,
      minSamples: timing.settleSamples,
      minStableMs,
    });
    const expired = at >= deadline;
    if (stable || expired) {
      const edit = await sendRename();
      if (!edit) {
        throw notRenameable();
      }
      const editPaths = editFilePaths(edit);
      const missing: string[] = [];
      const extra: string[] = [];
      for (const path of stability.paths) {
        if (!editPaths.has(path)) {
          missing.push(path);
        }
      }
      for (const path of editPaths) {
        if (!stability.paths.has(path)) {
          extra.push(path);
        }
      }
      if (missing.length === 0 && extra.length === 0) {
        if (stable) {
          return edit;
        }
        // 双向一致但稳定窗口未达标：索引可能仍在加载、残缺答案假稳定，
        // 宁可报可重试的不完整错误，也不把残缺结果当成功写盘。
        throw new RenameIncompleteError([], []);
      }
      if (expired || missing.length > 0) {
        throw new RenameIncompleteError(missing, extra);
      }
      // rename 报出 references 没有的文件：references 快照已过时，
      // 继续轮询到重新收敛后再重发 rename 复检（预算耗尽则向上抛）。
    }
    await sleep(timing.pollMs, signal);
    stability = trackStability({ previous: stability, paths: await refetchPaths(), now: now() });
  }
}

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
  if (line < 0 || line >= starts.length) {
    return [];
  }
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
    if (match[0] === symbol) {
      candidates.push({ line, character: match.index });
    }
  }
  return candidates;
}
