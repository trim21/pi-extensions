/**
 * 工作区文件监听器：单个递归 fs.watch + 去抖批量回调。
 *
 * - 事件源用 `node:fs/promises` 的 `watch(dir, { recursive: true, signal })`，
 *   不引入 chokidar（与仓库"FS 一律用 node:fs/promises"约定一致）；
 * - create / delete / rename 在底层都表现为 `rename`，内容改动为 `change`，
 *   故 LSP 的 created / changed / deleted 类型由 `lstat` 判定；
 * - 尾部去抖（缺省 300ms）合并短时洪峰，最长 flushMs（缺省 1s）强制清批；
 * - 内置忽略 `node_modules` / `.git` / `dist` / `build` / `.venv` / `venv` /
 *   `target` / `coverage`，配置可追加；
 * - 忽略列表同时下传给 `fs.watch` 的 `ignore` 选项做内核层排除（Node >= 24.14 /
 *   26 的 recursive watch 对命中路径不创建 inotify watch，避免大型 `.git` 等
 *   子树耗尽 watch 配额导致 ENOSPC 崩溃）；运行环境不支持时静默回退为事件层过滤；
 * - 单批超过 maxBatch（缺省 500）截断并回调 onTruncated 提示一次；
 * - 目录事件默认丢弃；目录被删除时上报（isDirectory: true），由上层对其中
 *   的驻留文档补 deleted 事件。监听器启动或运行期失败时调用 onError 降级，
 *   不抛错。
 */

import { lstat, watch, type WatchOptions as FsWatchOptions } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";

import { minimatch } from "minimatch";

export type FileChangeType = "created" | "changed" | "deleted";

export interface FileChange {
  /** 绝对路径（normalized）。 */
  path: string;
  type: FileChangeType;
  /** 目录被删除时 true（created/changed 目录事件默认不上报）。 */
  isDirectory: boolean;
}

export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/venv/**",
  "**/target/**",
  "**/coverage/**",
];

export interface WatchOptions {
  /** 尾部去抖窗口（ms，缺省 300）。 */
  debounceMs?: number;
  /** 从首个事件起的最长 flush 间隔（ms，缺省 1_000）。 */
  flushMs?: number;
  /** 单批上限，超出截断（缺省 500）。 */
  maxBatch?: number;
  /** 追加忽略 glob（相对工作区根的 POSIX 路径）。 */
  ignore?: string[];
  /** 监听器不可用（无法启动 / 运行期失败）时的降级提示回调。 */
  onError?: (message: string) => void;
  /** 单批超限被截断时回调（提示一次，不逐条刷屏）。 */
  onTruncated?: () => void;
}

export interface WorkspaceWatcher {
  stop(): Promise<void>;
}

function isIgnored(path: string, dir: string, patterns: string[]): boolean {
  const candidate = relative(dir, path).split(sep).join("/");
  if (candidate.startsWith("..")) return false;
  return patterns.some((pattern) => minimatch(candidate, pattern));
}

/**
 * 为内核层 `fs.watch` 的 `ignore` 选项派生 pattern：为每条「目录内容」形态的
 * glob（尾部为通配目录段）追加「目录本身」形态并去重——Node 内部按相对路径
 * 对每个子项逐一匹配，只给内容形态时忽略目录本身仍会建 watch。
 *
 * 与事件层 minimatch 的语义差异（Node 内部 matcher 固定 `matchBase: true`、
 * `nonegate: true`）：无斜杠 pattern 按 basename 匹配任意层级，`!` 否定在
 * 内核层不生效。内核层只会少产生事件，差异部分仍由事件层兜底。
 */
function kernelIgnorePatterns(patterns: readonly string[]): string[] {
  const derived = new Set<string>();
  for (const pattern of patterns) {
    derived.add(pattern);
    if (pattern.endsWith("/**")) derived.add(pattern.slice(0, -3));
  }
  return [...derived];
}

/**
 * `ignore` 选项的运行时支持始于 Node 24.14 / 26，@types/node 24.x 尚未声明；
 * 同时需剔除 fs 模块 WatchOptions.encoding 中的 "buffer" 字面量，否则不可赋给
 * fs/promises watch 返回 string filename 的重载。
 */
type FsWatchOptionsWithIgnore = Omit<FsWatchOptions, "encoding"> & {
  encoding?: BufferEncoding;
  ignore?: readonly string[];
};

/**
 * 启动对 dir 的递归监听。onBatch 收到去抖合并后的批次；stop 后不再回调。
 * 返回的 promise 只在监听器无法建立（目录不存在等）时 reject——运行期
 * 错误一律走 onError 降级。
 */
export function watchWorkspace(
  dir: string,
  onBatch: (changes: FileChange[]) => void,
  options?: WatchOptions,
): Promise<WorkspaceWatcher> {
  const debounceMs = options?.debounceMs ?? 300;
  const flushMs = options?.flushMs ?? 1_000;
  const maxBatch = options?.maxBatch ?? 500;
  const ignorePatterns = kernelIgnorePatterns([...DEFAULT_IGNORE, ...(options?.ignore ?? [])]);
  const abort = new AbortController();

  // 从 stat 成功事件学习已知目录，目录被删除时据此标记 isDirectory
  const seenDirectories = new Set<string>();

  let pending: FileChange[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (flushTimer) clearTimeout(flushTimer);
    if (maxTimer) clearTimeout(maxTimer);
    flushTimer = undefined;
    maxTimer = undefined;
  };

  const flush = (): void => {
    clearTimers();
    if (pending.length === 0) return;
    let batch = pending;
    pending = [];
    if (batch.length > maxBatch) {
      batch = batch.slice(0, maxBatch);
      options?.onTruncated?.();
    }
    onBatch(batch);
  };

  const push = (change: FileChange): void => {
    if (pending.length === 0) maxTimer = setTimeout(flush, flushMs);
    pending.push(change);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, debounceMs);
  };

  const classify = async (
    filename: string,
    eventType: "rename" | "change",
  ): Promise<FileChange | undefined> => {
    const path = normalize(join(dir, filename));
    if (path === dir) return undefined;
    let isDirectory = false;
    let exists = true;
    try {
      const info = await lstat(path);
      isDirectory = info.isDirectory();
      if (isDirectory) seenDirectories.add(path);
    } catch {
      exists = false;
      if (seenDirectories.delete(path)) isDirectory = true;
    }
    if (eventType === "change") {
      if (!exists) return { path, type: "deleted", isDirectory };
      if (isDirectory) return undefined;
      return { path, type: "changed", isDirectory };
    }
    // rename：创建 / 删除 / 移入移出
    if (!exists) return { path, type: "deleted", isDirectory };
    if (isDirectory) return undefined;
    return { path, type: "created", isDirectory };
  };

  const consumer = (async () => {
    try {
      const watchOptions: FsWatchOptionsWithIgnore = {
        recursive: true,
        signal: abort.signal,
        ignore: ignorePatterns,
      };
      const iterator = watch(dir, watchOptions);
      for await (const event of iterator) {
        if (!event.filename) continue;
        const change = await classify(
          event.filename,
          event.eventType === "change" ? "change" : "rename",
        );
        if (!change) continue;
        if (isIgnored(change.path, dir, ignorePatterns)) continue;
        push(change);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      options?.onError?.(`workspace watcher failed for ${dir}: ${String(error)}`);
    }
  })();

  // 目录不存在 / 无权限等启动期问题在这里暴露，让调用方可以降级
  return lstat(dir).then(() => ({
    async stop(): Promise<void> {
      abort.abort();
      try {
        await consumer;
      } catch {
        // 监听器已因 abort 正常退出
      }
    },
  }));
}
