/**
 * Workspace Guard Extension
 *
 * File-modifying tools (write, edit) are gated:
 * - Paths inside the workspace or /tmp are auto-allowed.
 * - Paths outside require user approval via confirmation dialog.
 *
 * Read tools (read, ls, find, grep) are unrestricted.
 *
 * Usage:
 *   pi -e workspace-guard
 */

import { isAbsolute, join, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRITE_TOOLS = new Set(["write", "edit"]);
const ALWAYS_ALLOW = ["/tmp"];

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

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
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

    const input = event.input as { path: string };
    const rawPath = input.path;
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
      choice = await ctx.ui.select(
        `Model requests write access outside workspace:\n\n` +
          `  Tool:  ${event.toolName}\n` +
          `  Path:  ${rawPath}\n` +
          `  Resolved: ${resolved}\n\nAllow?`,
        ["Approve once", "Block", "Block with reason"],
      );

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
