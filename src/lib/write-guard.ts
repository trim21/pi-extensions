/**
 * Workspace write guard, embedded directly in each write/edit tool.
 *
 * File-modifying tools gate themselves:
 * - Paths inside the workspace or /tmp are auto-allowed.
 * - Paths outside require user approval via a confirmation dialog showing a
 *   `diff` code block preview of the pending change.
 * - Headless sessions (no UI) reject outside writes outright.
 *
 * Callers have already parsed their tool arguments, so the guard only takes the
 * resolved pieces: the raw target path and the pending change (oldText/newText).
 */

import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";

import { normalizeForEdit, replace } from "../opencode/edit-engine.js";

const ALWAYS_ALLOW = ["/tmp"];
const MAX_PREVIEW_LINES = 100;

function isInside(dir: string, filePath: string): boolean {
  const rel = relative(dir, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isPathAllowed(absolutePath: string, cwd: string): boolean {
  if (isInside(cwd, absolutePath)) return true;

  for (const allowed of ALWAYS_ALLOW) {
    if (isInside(allowed, absolutePath)) return true;
  }

  return false;
}

/** Wrap patch text in a `diff` code block, truncating very large diffs. */
function wrapDiff(patch: string): string {
  const lines = patch.split("\n");
  if (lines.length > MAX_PREVIEW_LINES) {
    const truncated = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
    return `\`\`\`diff\n${truncated}\n… (preview truncated to ${MAX_PREVIEW_LINES} lines)\n\`\`\``;
  }
  return `\`\`\`diff\n${patch}\n\`\`\``;
}

/** The pending file change, described by the caller from already-parsed args. */
export interface PendingChange {
  /** Text to replace; empty for whole-file writes. */
  oldText: string;
  /** Replacement text. */
  newText: string;
  /** Replace all occurrences of oldText (edits only). */
  replaceAll?: boolean;
}

/**
 * Build a `diff` code block preview of the pending change.
 * Returns undefined when the diff cannot be computed.
 */
export async function buildDiffPreview(
  resolvedPath: string,
  change: PendingChange,
): Promise<string | undefined> {
  let oldContent = "";
  try {
    oldContent = await readFile(resolvedPath, "utf8");
  } catch {
    // Unreadable or missing file: treat as empty so writes show as full additions.
  }

  if (change.oldText === "") {
    // Whole-file write: show the full addition/replacement patch.
    return wrapDiff(generateUnifiedPatch(basename(resolvedPath), oldContent, change.newText, 2));
  }

  // Edit: reuse the real matching engine to locate oldText, giving a
  // line-numbered patch when it matches. Fall back to a parameter diff when the
  // edit cannot be applied (oldText not found, ambiguous, or no file).
  try {
    const normalized = normalizeForEdit(oldContent);
    const newContent = replace(normalized, change.oldText, change.newText, change.replaceAll);
    // The full path is shown in the dialog title, so the patch header only
    // carries the file name.
    return wrapDiff(generateUnifiedPatch(basename(resolvedPath), normalized, newContent, 2));
  } catch {
    const removed = change.oldText.split("\n").map((line) => `-${line}`);
    const added = change.newText.split("\n").map((line) => `+${line}`);
    return wrapDiff([...removed, ...added].join("\n"));
  }
}

export interface WriteGuardContext {
  cwd: string;
  hasUI: boolean;
  abort?: () => void;
  ui?: {
    select: (title: string, options: string[]) => Promise<string | undefined>;
    input: (title: string, placeholder?: string) => Promise<string | undefined>;
  };
}

export interface WriteGuardOptions {
  toolName: string;
  /** The resolved absolute target path (caller has already parsed its args). */
  absolutePath: string;
  change: PendingChange;
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
  if (!ctx) return;
  const { absolutePath } = opts;
  if (isPathAllowed(absolutePath, ctx.cwd)) return;

  if (!ctx.hasUI || !ctx.ui) {
    throw new Error(`Path "${absolutePath}" is outside workspace. No UI available for approval.`);
  }

  while (true) {
    const diffPreview = await buildDiffPreview(absolutePath, opts.change);
    const title =
      `Model requests write access outside workspace:\n\n` +
      `  Tool:  ${opts.toolName}\n` +
      `  Path:  ${absolutePath}\n` +
      (diffPreview ? `\n${diffPreview}\n` : "") +
      `\nAllow?`;

    const choice = await ctx.ui.select(title, ["Approve once", "Block", "Block with reason"]);
    if (choice === undefined) {
      ctx.abort?.();
      throw new Error("Write outside workspace cancelled by user.");
    }
    if (choice === "Approve once") return;
    if (choice === "Block") throw new Error("Write outside workspace denied by user.");
    const feedback = await ctx.ui.input("Why was this write denied?");
    if (feedback === undefined) continue;
    throw new Error(
      feedback
        ? `Write outside workspace denied: ${feedback}`
        : "Write outside workspace denied by user.",
    );
  }
}
