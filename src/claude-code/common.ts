import { readdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const fileSnapshotSchema = Type.Object({
  digest: Type.String(),
  textEditable: Type.Boolean(),
  // 以下字段仅 Read 写入，供同范围重复读取 dedup；Edit/Write 不写，
  // 覆盖记录后 offset 缺省 → 不再 dedup，强制重新 Read（对齐 CC readFileState）
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

export type FileSnapshot = Static<typeof fileSnapshotSchema>;

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

/** 相对 cwd 的路径（超出 cwd 则保留绝对路径），对齐 Claude Code 省 token。 */
export function toRelativePath(filePath: string, cwd: string): string {
  const relativePath = relative(cwd, filePath);
  return relativePath.startsWith("..") ? filePath : relativePath;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

export function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.digest === right.digest;
}

/**
 * 同目录下"同名不同扩展名"的文件（如请求 foo.ts 不存在，目录里有 foo.js），
 * 对齐 Claude Code 的 findSimilarFile。返回文件名（不含路径）。
 */
export function findSimilarFile(filePath: string): string | undefined {
  try {
    const dir = dirname(filePath);
    const fileBaseName = basename(filePath, extname(filePath));
    const similar = readdirSync(dir).find(
      (name) => basename(name, extname(name)) === fileBaseName && join(dir, name) !== filePath,
    );
    return similar;
  } catch {
    // 目录不存在（ENOENT）属预期，其他错误同样不阻塞建议
    return undefined;
  }
}

/**
 * Dropped-repo-folder 检测（对齐 Claude Code 的 suggestPathUnderCwd）：模型给出
 * 的绝对路径可能少了仓库目录组件。若请求路径位于 cwd 的父目录下（但不在 cwd
 * 内），把相对父目录的部分拼到 cwd 下，存在则返回完整路径。
 */
export async function suggestPathUnderCwd(
  requestedPath: string,
  cwd: string,
): Promise<string | undefined> {
  const cwdParent = dirname(cwd);
  // realpath 解析请求路径的父目录（如 macOS /tmp → /private/tmp），保证与
  // cwd 的前缀比较一致
  let resolvedPath = requestedPath;
  try {
    const resolvedDir = await realpath(dirname(requestedPath));
    resolvedPath = join(resolvedDir, basename(requestedPath));
  } catch {
    // 父目录不存在，用原路径
  }
  const cwdParentPrefix = cwdParent === sep ? sep : cwdParent + sep;
  if (
    resolvedPath === cwd ||
    !resolvedPath.startsWith(cwdParentPrefix) ||
    resolvedPath.startsWith(cwd + sep)
  ) {
    return undefined;
  }
  const relFromParent = relative(cwdParent, resolvedPath);
  const correctedPath = join(cwd, relFromParent);
  try {
    await stat(correctedPath);
    return correctedPath;
  } catch {
    return undefined;
  }
}

/** "Did you mean" 建议：优先 cwd 重定位，其次同名不同扩展（对齐 Claude Code）。 */
export async function didYouMean(filePath: string, cwd: string): Promise<string | undefined> {
  const cwdSuggestion = await suggestPathUnderCwd(filePath, cwd);
  if (cwdSuggestion) return cwdSuggestion;
  return findSimilarFile(filePath);
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
