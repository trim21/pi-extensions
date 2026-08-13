/**
 * Shared path helpers used by multiple extensions.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
