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
 * Callers have already parsed their tool arguments and computed the result, so the
 * guard takes the resolved pieces: the raw target path and the mutation (the file's
 * content before and after). The preview is rendered from those two strings, so the
 * approved diff is the change that gets written.
 */

import { basename, isAbsolute, relative, sep } from "node:path";

import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";

import { digestIfExists, snapshotOf } from "./file-reads.js";
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
 * 待审批的写入：内容由调用方先读盘并算好，批准后按 `contentNew` 落盘。
 *
 * 两份内容都是文件原始内容（保留 BOM 与行尾），不是匹配引擎的中间产物——这样
 * 预览就是磁盘前后的真实对照，批准后的指纹校验也能与磁盘字节逐字节对上。
 */
export interface FileMutation {
  /** 变更前的完整文件内容（文件不存在时为 ""）。 */
  readonly contentOld: string;
  /** 变更后的完整内容——即批准后写进磁盘的字节。 */
  readonly contentNew: string;
}

/** 预览统一按 LF 渲染：CRLF 文件的 diff 每行都带 \r，在对话框里显示成乱码。 */
function normalizeToLF(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/** 待审批写入的 diff 代码块：由将落盘的内容直接算出，不做第二次匹配。 */
export function renderMutationPreview(resolvedPath: string, mutation: FileMutation): string {
  return wrapDiff(
    generateUnifiedPatch(
      basename(resolvedPath),
      normalizeToLF(mutation.contentOld),
      normalizeToLF(mutation.contentNew),
      2,
    ),
  );
}

/** 空内容的指纹：文件不存在与空文件在审批视角下等价。 */
const EMPTY_DIGEST = snapshotOf("").digest;

/**
 * 批准后重新取一次磁盘指纹：用户停留在对话框上的这段时间文件可能被外部改动，
 * 此时按审批所用的旧内容算出的 `contentNew` 会覆盖别人的改动。
 */
async function requireApprovedContentStillCurrent(opts: WriteGuardOptions): Promise<void> {
  const { mutation } = opts;
  if (mutation === undefined) {
    return;
  }
  const current = (await digestIfExists(opts.absolutePath)) ?? EMPTY_DIGEST;
  if (current !== snapshotOf(mutation.contentOld).digest) {
    throw new Error(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
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
   * 待审批的写入（变更前后的完整内容）；缺省时审批对话框不展示 diff 预览，
   * 仅按路径审批（流式落盘的工具用不上它）。
   */
  mutation?: FileMutation;
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
    const diffPreview =
      opts.mutation === undefined ? undefined : renderMutationPreview(absolutePath, opts.mutation);
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
      await requireApprovedContentStillCurrent(opts);
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
