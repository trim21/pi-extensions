/**
 * 工作区文件监听器：@parcel/watcher 事件源 + 去抖批量回调。
 *
 * - 事件源用 @parcel/watcher（原生实现，Linux 正确管理 inotify 生命周期，
 *   忽略目录不建 watch，事件已区分 create / update / delete），
 *   映射为 LSP 的 created / changed / deleted；
 * - parcel 不报告目标是否目录：非删除事件用 lstat 学习已知目录集合并丢弃
 *   目录事件；删除事件据此标记 isDirectory，由上层对驻留文档补 deleted；
 * - 尾部去抖（缺省 300ms）合并短时洪峰，最长 flushMs（缺省 1s）强制清批；
 * - 内置忽略 `node_modules` / `.git` / `dist` / `build` / `.venv` / `venv` /
 *   `target` / `coverage`，配置可追加；忽略列表下传 parcel 的 `ignore`
 *   选项做后端层排除（忽略目录不递归、不建 watch），事件层再用 minimatch
 *   过滤一遍兜底语义差异；
 * - 单批超过 maxBatch（缺省 500）截断并回调 onTruncated 提示一次；
 * - 目录事件默认丢弃；目录被删除时上报（isDirectory: true）。监听器启动或
 *   运行期失败时调用 onError 降级，不抛错。
 */

import { lstat } from "node:fs/promises";
import { normalize, relative, sep } from "node:path";

import {
  type AsyncSubscription,
  type Event as ParcelWatcherEvent,
  subscribe,
} from "@parcel/watcher";
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
  const ignorePatterns = [...DEFAULT_IGNORE, ...(options?.ignore ?? [])];

  // 从非删除事件学习已知目录，目录被删除时据此标记 isDirectory
  const seenDirectories = new Set<string>();

  let stopped = false;
  let subscription: AsyncSubscription | undefined;

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
    if (stopped) return;
    if (pending.length === 0) maxTimer = setTimeout(flush, flushMs);
    pending.push(change);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, debounceMs);
  };

  const classify = async (path: string, type: FileChangeType): Promise<FileChange | undefined> => {
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
    if (type === "deleted") return { path, type, isDirectory };
    // 事件与 lstat 之间的竞态：目标已消失按删除处理
    if (!exists) return { path, type: "deleted", isDirectory };
    if (isDirectory) return undefined;
    return { path, type, isDirectory };
  };

  const handleError = (error: unknown): void => {
    if (stopped) return;
    options?.onError?.(`workspace watcher failed for ${dir}: ${String(error)}`);
  };

  const handleEvents = (error: Error | null, events: ParcelWatcherEvent[]): void => {
    if (error) {
      handleError(error);
      return;
    }
    void (async () => {
      for (const event of events) {
        if (stopped) return;
        const path = normalize(event.path);
        const type: FileChangeType =
          event.type === "create" ? "created" : event.type === "update" ? "changed" : "deleted";
        const change = await classify(path, type);
        if (!change) continue;
        if (isIgnored(change.path, dir, ignorePatterns)) continue;
        push(change);
      }
    })();
  };

  async function startSubscription(): Promise<void> {
    try {
      subscription = await subscribe(dir, handleEvents, { ignore: ignorePatterns });
      if (stopped) {
        await subscription.unsubscribe();
        subscription = undefined;
      }
    } catch (error) {
      handleError(error);
    }
  }

  const started = startSubscription();

  // 目录不存在 / 无权限等启动期问题在这里暴露，让调用方可以降级
  return lstat(dir).then(() => ({
    async stop(): Promise<void> {
      stopped = true;
      clearTimers();
      if (subscription) {
        try {
          await subscription.unsubscribe();
        } catch {
          // 订阅已失败或重复 stop
        }
        subscription = undefined;
      }
      await started;
    },
  }));
}
