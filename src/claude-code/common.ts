import { isAbsolute, normalize, resolve } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

export interface FileSnapshot {
  digest: string;
  textEditable: boolean;
}

const fileSnapshotSchema = Type.Object({
  digest: Type.String(),
  textEditable: Type.Boolean(),
});

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

/**
 * 从工具结果 details 里恢复文件已读记账（跨进程 resume / reload / fork）。
 * 数据来自 session 文件，可能缺失或损坏：逐条 TypeBox 校验，非法条目丢弃。
 * 只接受 plain object，数组、null 等异常形态直接返回空 map。
 */
export function deserializeReads(data: unknown): Map<string, FileSnapshot> {
  const reads = new Map<string, FileSnapshot>();
  if (typeof data !== "object" || data === null || Array.isArray(data)) return reads;
  for (const [filePath, snapshot] of Object.entries(data)) {
    if (Value.Check(fileSnapshotSchema, snapshot)) reads.set(filePath, snapshot);
  }
  return reads;
}
