import { isAbsolute, normalize, resolve } from "node:path";

export interface FileSnapshot {
  digest: string;
  textEditable: boolean;
}

export interface ClaudeCodeState {
  readonly reads: Map<string, FileSnapshot>;
}

export function createClaudeCodeState(): ClaudeCodeState {
  return { reads: new Map() };
}

export function requireAbsolutePath(filePath: string, parameter = "file_path"): string {
  if (!isAbsolute(filePath)) {
    throw new Error(`The ${parameter} parameter must be an absolute path, not a relative path.`);
  }
  return normalize(filePath);
}

/** Resolve a search root path against the working directory. */
export function searchRoot(path: string | undefined, cwd: string): string {
  if (!path) return cwd;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

export function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.digest === right.digest;
}
