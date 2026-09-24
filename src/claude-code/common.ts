import { readdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolvePathArg } from "../lib/path.js";

/**
 * 解析 `file_path`：绝对路径规整化后原样使用，相对路径（含 `~` 前缀）按调用
 * cwd 展开。工具内部一律用解析后的绝对路径，写保护与 reads 记账都依赖它。
 */
export function resolveToolFilePath(filePath: string, cwd: string): string {
  return resolve(resolvePathArg(cwd, filePath));
}

/** Resolve a search root path against the working directory. */
export function searchRoot(path: string | undefined, cwd: string): string {
  if (!path) {
    return cwd;
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** 相对 cwd 的路径（超出 cwd 则保留绝对路径），对齐 Claude Code 省 token。 */
export function toRelativePath(filePath: string, cwd: string): string {
  const relativePath = relative(cwd, filePath);
  return relativePath.startsWith("..") ? filePath : relativePath;
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
  if (cwdSuggestion) {
    return cwdSuggestion;
  }
  return findSimilarFile(filePath);
}
