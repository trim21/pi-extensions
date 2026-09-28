/**
 * Workspace write guard, embedded directly in each write/edit tool.
 *
 * File-modifying tools gate themselves:
 * - Paths inside the workspace or /tmp are auto-allowed.
 * - Paths outside require user approval via a confirmation dialog showing a
 *   `diff` code block preview of the pending change.
 * - Headless sessions (no UI) reject outside writes outright.
 * - Windows (no sandbox fallback): writes are restricted to the workspace;
 *   outside paths are rejected outright, with no approval path.
 * - `/bwrap-deny-request` (non-sandbox request policy) refuses outside writes
 *   outright, with the same error as the user picking "Block".
 *
 * Callers have already parsed their tool arguments, so the guard only takes the
 * resolved pieces: the raw target path and the pending change. An edit carries
 * the caller's own matching implementation, so the previewed diff comes from the
 * same semantics that will write the file.
 */

import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";

import { fenceCodeBlock } from "./markdown.js";
import type { RequestPolicy } from "./request-policy.js";

const ALWAYS_ALLOW = ["/tmp"];
const MAX_PREVIEW_LINES = 100;

function isInside(dir: string, filePath: string): boolean {
  const rel = relative(dir, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isPathAllowed(absolutePath: string, cwd: string): boolean {
  if (isInside(cwd, absolutePath)) {
    return true;
  }

  for (const allowed of ALWAYS_ALLOW) {
    if (isInside(allowed, absolutePath)) {
      return true;
    }
  }

  return false;
}

/** Wrap patch text in a `diff` code block, truncating very large diffs. */
function wrapDiff(patch: string): string {
  const lines = patch.split("\n");
  const body =
    lines.length > MAX_PREVIEW_LINES
      ? `${lines.slice(0, MAX_PREVIEW_LINES).join("\n")}\n… (preview truncated to ${MAX_PREVIEW_LINES} lines)`
      : patch;
  // fenceCodeBlock 选更长的围栏，避免 patch 内容里的 ``` 提前闭合代码块
  return fenceCodeBlock(body, "diff");
}

/**
 * 审批预览用的应用函数：把这次改动套到文件内容上，返回 diff 用的前后文本。
 * 必须是该工具落盘时使用的同一套匹配实现——否则对话框展示的 diff 与实际写入
 * 可能不一致。
 */
export type PendingChangeApply = (fileContent: string) => {
  readonly contentOld: string;
  readonly contentNew: string;
};

/** 整文件写入：预览是完整的增删 patch，不需要匹配实现。 */
export interface FileWriteChange {
  readonly kind: "write";
  readonly newText: string;
}

/**
 * 替换：`apply` 是调用方自己的匹配实现（精确匹配、模糊匹配，或已展开好的整文件
 * 编辑）。匹配不上时抛错即可，写保护会退化为参数 diff。
 */
export interface FileEditChange {
  readonly kind: "edit";
  readonly oldText: string;
  readonly newText: string;
  readonly apply: PendingChangeApply;
}

/** The pending file change, described by the caller from already-parsed args. */
export type PendingChange = FileWriteChange | FileEditChange;

/** 预览统一按 LF 渲染：CRLF 文件的 diff 每行都带 \r，在对话框里显示成乱码。 */
function normalizeToLF(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/** 参数 diff：调用方的匹配实现报告不出结果时的兜底形式。 */
function parameterDiff(oldText: string, newText: string): string {
  const removed = oldText.split("\n").map((line) => `-${line}`);
  const added = newText.split("\n").map((line) => `+${line}`);
  return [...removed, ...added].join("\n");
}

/**
 * Build a `diff` code block preview of the pending change.
 * Returns undefined when the diff cannot be computed.
 */
export async function buildDiffPreview(
  resolvedPath: string,
  change: PendingChange,
): Promise<string | undefined> {
  let fileContent = "";
  try {
    fileContent = await readFile(resolvedPath, "utf8");
  } catch {
    // Unreadable or missing file: treat as empty so writes show as full additions.
  }

  if (change.kind === "write") {
    // Whole-file write: show the full addition/replacement patch.
    return wrapDiff(generateUnifiedPatch(basename(resolvedPath), fileContent, change.newText, 2));
  }

  // 定位由调用方的匹配实现负责（与其落盘同语义）；匹配不上时退回参数 diff。
  try {
    const { contentOld, contentNew } = change.apply(fileContent);
    return wrapDiff(
      generateUnifiedPatch(
        basename(resolvedPath),
        normalizeToLF(contentOld),
        normalizeToLF(contentNew),
        2,
      ),
    );
  } catch {
    return wrapDiff(parameterDiff(change.oldText, change.newText));
  }
}

export interface WriteGuardContext {
  cwd: string;
  hasUI: boolean;
  abort?: () => void;
  ui?: {
    select: (
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
    input: (
      title: string,
      placeholder?: string,
      opts?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
  };
}

export interface WriteGuardOptions {
  toolName: string;
  /** The resolved absolute target path (caller has already parsed its args). */
  absolutePath: string;
  /**
   * 待审批的变更内容；缺省时审批对话框不展示 diff 预览，仅按路径审批。
   */
  change?: PendingChange;
  /** 调用方所在扩展入口持有的非沙盒请求策略（跨入口一致时绑同一个 pi.events）。 */
  policy: RequestPolicy;
  /** 工具调用的中止信号：透传给审批对话框，工具被取消时对话框一起关掉。 */
  signal?: AbortSignal;
}

/**
 * Gate a write/edit call by its target path: auto-allows workspace and /tmp
 * writes, otherwise asks for user approval (or rejects in headless sessions).
 * Throws when the write is denied.
 */
export async function guardWriteAccess(
  ctx: WriteGuardContext | undefined,
  opts: WriteGuardOptions,
): Promise<void> {
  if (!ctx) {
    return;
  }
  const { absolutePath } = opts;
  if (isPathAllowed(absolutePath, ctx.cwd)) {
    return;
  }

  // 非沙盒请求策略生效时不弹审批框：工作区外写入按用户点 "Block"（无理由）处理。
  // 放在 win32 / 无 UI 分支之前，策略优先级高于各平台的降级路径。
  if (opts.policy.deniesRequests()) {
    throw new Error(`user deny ${opts.toolName}: blocked`);
  }

  if (process.platform === "win32") {
    // Windows 上退化为「只能写工作区」：无沙箱兜底，工作区外写入一律拒绝，
    // 不提供审批路径。
    throw new Error(
      `Path "${absolutePath}" is outside workspace. Writes outside the workspace are not allowed on Windows.`,
    );
  }

  if (!ctx.hasUI || !ctx.ui) {
    throw new Error(`Path "${absolutePath}" is outside workspace. No UI available for approval.`);
  }

  for (;;) {
    const diffPreview = opts.change ? await buildDiffPreview(absolutePath, opts.change) : undefined;
    const title =
      `Model requests write access outside workspace:\n\n` +
      `  Tool:  ${opts.toolName}\n` +
      `  Path:  ${absolutePath}\n` +
      (diffPreview ? `\n${diffPreview}\n` : "") +
      `\nAllow?`;

    const choice = await ctx.ui.select(title, ["Approve once", "Block", "Block with reason"], {
      signal: opts.signal,
    });
    if (choice === undefined) {
      ctx.abort?.();
      throw new Error(`user deny ${opts.toolName}: cancelled`);
    }
    if (choice === "Approve once") {
      return;
    }
    if (choice === "Block") {
      throw new Error(`user deny ${opts.toolName}: blocked`);
    }
    const feedback = await ctx.ui.input("Why was this write denied?", undefined, {
      signal: opts.signal,
    });
    if (feedback === undefined) {
      continue;
    }
    throw new Error(
      feedback ? `user deny ${opts.toolName}: ${feedback}` : `user deny ${opts.toolName}: blocked`,
    );
  }
}
