/**
 * Shared path helpers used by multiple extensions.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Expand a leading `~` to the user's home directory.
 * - `~` → home
 * - `~/rest` → `home/rest`
 * - anything else (including `~user`) is left untouched.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a path that may start with `~` (expanded to home) and may be
 * relative (resolved against `baseDir`). Absolute paths are returned
 * normalized.
 */
export function resolveHomePath(p: string, baseDir: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/**
 * Resolve a command `workdir` argument: absolute paths are used as-is, relative
 * paths resolve against `baseDir`. Throws if the target does not exist or is
 * not a directory.
 */
export async function resolveWorkdir(workdir: string, baseDir: string): Promise<string> {
  const target = isAbsolute(workdir) ? workdir : resolve(baseDir, workdir);
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new Error(`Working directory does not exist: ${target}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${target}`);
  }
  return target;
}

/** 人类可读的显示路径：cwd 内用 `./…`，home 内用 `~/…`，否则原样绝对路径。 */
export function formatDisplayPath(cwd: string, filePath: string): string {
  const relToCwd = relative(cwd, filePath);
  if (relToCwd !== "" && !relToCwd.startsWith("..") && !isAbsolute(relToCwd)) {
    return `./${relToCwd}`;
  }
  const relToHome = relative(homedir(), filePath);
  if (relToHome !== "" && !relToHome.startsWith("..") && !isAbsolute(relToHome)) {
    return `~/${relToHome}`;
  }
  return filePath;
}

/** subtitle 中路径的最大显示长度，超过时退化为 `parent/basename`。 */
export const MAX_SUBTITLE_PATH_LENGTH = 20;

function shortenSubtitlePath(filePath: string, display: string): string {
  if (display.length <= MAX_SUBTITLE_PATH_LENGTH) return display;
  const name = basename(filePath);
  const parentDir = dirname(filePath);
  const parentName = basename(parentDir);
  if (parentName === "" || parentName === "." || parentDir === parentName) return name;
  return join(parentName, name);
}

function formatSubtitleCounts(errorCount?: number, warningCount?: number): string {
  const parts: string[] = [];
  if (errorCount) parts.push(`ⓧ ${errorCount}`);
  if (warningCount) parts.push(`⚠ ${warningCount}`);
  return parts.join(" ");
}

/** subtitle 用的显示路径：优先 `./…` / `~/…` / 绝对路径，过长时显示上一级目录加文件名。 */
export function formatSubtitlePath(
  cwd: string,
  filePath: string,
  errorCount?: number,
  warningCount?: number,
): string {
  const pathText = shortenSubtitlePath(filePath, formatDisplayPath(cwd, filePath));
  const counts = formatSubtitleCounts(errorCount, warningCount);
  return counts ? `${pathText} (${counts})` : pathText;
}
