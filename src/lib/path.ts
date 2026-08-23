/**
 * Shared path helpers used by multiple extensions.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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
