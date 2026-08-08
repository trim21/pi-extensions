/**
 * Workspace Guard Extension
 *
 * File-modifying tools (write, edit) are gated:
 * - Paths inside the workspace or /tmp are auto-allowed.
 * - Paths outside require user approval via confirmation dialog.
 *   The dialog shows a ```diff code block preview of the pending change.
 *
 * Read tools (read, ls, find, grep) are unrestricted.
 *
 * Usage:
 *   pi -e workspace-guard
 */

import { basename, isAbsolute, join, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import {
  generateUnifiedPatch,
  type ExtensionAPI,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { normalizeForEdit, replace } from "./opencode-edit-engine.js";

const WRITE_TOOLS = new Set(["write", "edit"]);
const ALWAYS_ALLOW = ["/tmp"];

/** Maximum lines of the diff preview shown in the approval dialog. */
const MAX_PREVIEW_LINES = 100;

export function getWriteTarget(input: ToolCallEvent["input"]): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  if ("path" in input && typeof input.path === "string") return input.path;
  if ("filePath" in input && typeof input.filePath === "string") return input.filePath;
  return undefined;
}

function resolvePath(filePath: string, cwd: string): string {
  let p = filePath;
  if (p.startsWith("~")) {
    const rest = p.slice(1);
    if (rest === "" || rest.startsWith("/")) {
      p = join(homedir(), rest.slice(1));
    }
  }
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function isInside(dir: string, filePath: string): boolean {
  const rel = relative(dir, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isPathAllowed(resolvedPath: string, cwd: string): boolean {
  if (isInside(cwd, resolvedPath)) return true;

  for (const allowed of ALWAYS_ALLOW) {
    const resolvedAllowed = resolvePath(allowed, cwd);
    if (isInside(resolvedAllowed, resolvedPath)) return true;
  }

  return false;
}

/**
 * Type guard for built-in edit entries `{ oldText, newText }`.
 */
function isEditPair(value: unknown): value is { oldText: string; newText: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "oldText" in value &&
    typeof value.oldText === "string" &&
    "newText" in value &&
    typeof value.newText === "string"
  );
}

/**
 * Extract the opencode-style edit pair `{ oldString, newString, replaceAll }`.
 */
function getOpencodeEditPair(
  input: ToolCallEvent["input"],
): { oldString: string; newString: string; replaceAll: boolean } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  if (!("oldString" in input) || !("newString" in input)) return undefined;
  if (typeof input.oldString !== "string" || typeof input.newString !== "string") return undefined;
  return {
    oldString: input.oldString,
    newString: input.newString,
    replaceAll: "replaceAll" in input && input.replaceAll === true,
  };
}

/**
 * Apply the pending write/edit to `content`.
 * Returns undefined when the change cannot be applied (missing fields or oldText not found).
 */
function applyChange(
  toolName: string,
  input: ToolCallEvent["input"],
  content: string,
): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;

  if (toolName === "write") {
    return "content" in input && typeof input.content === "string" ? input.content : undefined;
  }

  // Built-in edit: { path, edits: [{ oldText, newText }] }
  if ("edits" in input && Array.isArray(input.edits)) {
    let next = content;
    for (const edit of input.edits) {
      if (!isEditPair(edit)) return undefined;
      if (!next.includes(edit.oldText)) return undefined;
      next = next.replace(edit.oldText, edit.newText);
    }
    return next;
  }

  return undefined;
}

/** Wrap patch text in a ```diff code block, truncating very large diffs. */
function wrapDiff(patch: string): string {
  const lines = patch.split("\n");
  if (lines.length > MAX_PREVIEW_LINES) {
    const truncated = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
    return `\`\`\`diff\n${truncated}\n… (preview truncated to ${MAX_PREVIEW_LINES} lines)\n\`\`\``;
  }
  return `\`\`\`diff\n${patch}\n\`\`\``;
}

/**
 * Build a ```diff code block preview of the pending change.
 * Returns undefined when the diff cannot be computed.
 */
export async function buildDiffPreview(
  toolName: string,
  input: ToolCallEvent["input"],
  resolvedPath: string,
): Promise<string | undefined> {
  let oldContent = "";
  try {
    oldContent = await readFile(resolvedPath, "utf-8");
  } catch {
    // Unreadable or missing file: treat as empty so writes show as full additions.
  }

  // opencode-edit: reuse the real matching engine to locate oldString, giving a
  // line-numbered patch when it matches. Fall back to a parameter diff when the
  // edit cannot be applied (oldString not found, ambiguous, or no file).
  const pair = getOpencodeEditPair(input);
  if (pair) {
    try {
      const normalized = normalizeForEdit(oldContent);
      const newContent = replace(normalized, pair.oldString, pair.newString, pair.replaceAll);
      // The full path is shown in the dialog title, so the patch header only
      // carries the file name.
      return wrapDiff(generateUnifiedPatch(basename(resolvedPath), normalized, newContent, 2));
    } catch {
      const removed = pair.oldString.split("\n").map((line) => `-${line}`);
      const added = pair.newString.split("\n").map((line) => `+${line}`);
      return wrapDiff([...removed, ...added].join("\n"));
    }
  }

  const newContent = applyChange(toolName, input, oldContent);
  if (newContent === undefined) return undefined;

  return wrapDiff(generateUnifiedPatch(basename(resolvedPath), oldContent, newContent, 2));
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const currentCwd = ctx.cwd;
    return {
      systemPrompt:
        event.systemPrompt +
        `\nWorkspace write protection is active. ` +
        `write and edit to paths inside the workspace "${currentCwd}" or /tmp are auto-allowed. ` +
        `Paths outside require user approval before execution.`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!WRITE_TOOLS.has(event.toolName)) return;

    const rawPath = getWriteTarget(event.input);
    if (!rawPath) return;

    const resolved = resolvePath(rawPath, ctx.cwd);

    if (isPathAllowed(resolved, ctx.cwd)) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Path "${rawPath}" is outside workspace. No UI available for approval.`,
      };
    }

    let choice: string | undefined;
    while (!choice) {
      const diffPreview = await buildDiffPreview(event.toolName, event.input, resolved);

      const title =
        `Model requests write access outside workspace:\n\n` +
        `  Tool:  ${event.toolName}\n` +
        `  Path:  ${rawPath}\n` +
        `  Resolved: ${resolved}\n` +
        (diffPreview ? `\n${diffPreview}\n` : "") +
        `\nAllow?`;

      choice = await ctx.ui.select(title, ["Approve once", "Block", "Block with reason"]);

      if (typeof choice === "undefined") {
        ctx.abort();
        return { block: true, reason: "Write outside workspace cancelled by user." };
      }

      if (choice === "Block with reason") {
        const feedback = await ctx.ui.input("Why was this write denied?");
        if (feedback === undefined) {
          choice = undefined; // cancelled input, retry select
          continue;
        }
        return {
          block: true,
          reason: feedback
            ? `Write outside workspace denied: ${feedback}`
            : "Write outside workspace denied by user.",
        };
      }
    }

    if (choice !== "Approve once") {
      return { block: true, reason: "Write outside workspace denied by user." };
    }
  });
}
