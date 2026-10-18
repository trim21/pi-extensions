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
 *   `target` / `coverage` 与常见缓存目录（`__pycache__` / `.mypy_cache` /
 *   `.pytest_cache` / `.ruff_cache` / `.cache` / `.next` / `.turbo` /
 *   `.gradle` / `.tox` / `.nox` / `.idea`），配置可追加；忽略列表下传 parcel
 *   的 `ignore` 选项做后端层排除（忽略目录不递归、不建 watch），事件层再用
 *   minimatch 过滤一遍兜底语义差异；`ignoreDirs` 里的绝对路径目录只下传后端
 *   （被忽略目录不会产生事件，无需事件层重复过滤）；
 * - 单批超过 maxBatch（缺省 500）截断并回调 onTruncated 提示一次；
 * - 目录事件默认丢弃；目录被删除时上报（isDirectory: true）；
 * - 订阅因资源耗尽（ENOSPC / EMFILE）失败时，若配置了 pollingIntervalMs，
 *   改用快照轮询（getEventsSince + writeSnapshot）继续投递事件并回调
 *   onDegraded；轮询自身失败回落 onError；
 * - 监听器其他失败调用 onError 降级，不抛错。
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, sep } from "node:path";

import {
  type AsyncSubscription,
  type Event as ParcelWatcherEvent,
  getEventsSince,
  subscribe,
  writeSnapshot,
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

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/venv/**",
  "**/target/**",
  "**/coverage/**",
  // 语义明确的缓存 / 工具产物目录；out / bin / obj 可能是源码目录，不在此列
  "**/__pycache__/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/.ruff_cache/**",
  "**/.cache/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.gradle/**",
  "**/.tox/**",
  "**/.nox/**",
  "**/.idea/**",
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
  /** 追加忽略的绝对路径目录（如 gitignore 的整体忽略目录）；只下传后端。 */
  ignoreDirs?: string[];
  /** 订阅因资源耗尽失败时改用快照轮询的间隔（ms）；不传表示不降级。 */
  pollingIntervalMs?: number;
  /** 监听器不可用（无法启动 / 运行期失败）时的降级提示回调。 */
  onError?: (message: string) => void;
  /** 已从 inotify 订阅降级为快照轮询时回调一次。 */
  onDegraded?: (message: string) => void;
  /** 单批超限被截断时回调（提示一次，不逐条刷屏）。 */
  onTruncated?: () => void;
}

export interface WorkspaceWatcher {
  stop(): Promise<void>;
}

function isIgnored(path: string, dir: string, patterns: string[]): boolean {
  const candidate = relative(dir, path).split(sep).join("/");
  if (candidate.startsWith("..")) {
    return false;
  }
  return patterns.some((pattern) => minimatch(candidate, pattern));
}

/** inotify 资源耗尽：可降级为快照轮询；其他错误一律走 onError。 */
const EXHAUSTED_ERROR = /ENOSPC|EMFILE|No space left on device/i;

function snapshotPathFor(dir: string): string {
  const hash = createHash("sha1").update(dir).digest("hex");
  return join(tmpdir(), "pi-lsp-watch", `${hash}-${process.pid}.snapshot`);
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
  const ignoreDirs = options?.ignoreDirs ?? [];
  const pollingIntervalMs = options?.pollingIntervalMs;

  // 从非删除事件学习已知目录，目录被删除时据此标记 isDirectory
  const seenDirectories = new Set<string>();

  let stopped = false;
  let subscription: AsyncSubscription | undefined;

  let pending: FileChange[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;

  let pollingTimer: ReturnType<typeof setInterval> | undefined;
  let snapshotFile: string | undefined;
  let pollingStarting = false;
  let pollingRunning = false;
  let degradedNotified = false;

  // 跨 await 读取 stop 状态：直接读 let 会被 TS 收窄成 await 前的字面量
  const isStopped = (): boolean => stopped;

  const clearTimers = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
    }
    if (maxTimer) {
      clearTimeout(maxTimer);
    }
    flushTimer = undefined;
    maxTimer = undefined;
  };

  const flush = (): void => {
    clearTimers();
    if (pending.length === 0) {
      return;
    }
    let batch = pending;
    pending = [];
    if (batch.length > maxBatch) {
      batch = batch.slice(0, maxBatch);
      options?.onTruncated?.();
    }
    onBatch(batch);
  };

  const push = (change: FileChange): void => {
    if (stopped) {
      return;
    }
    if (pending.length === 0) {
      maxTimer = setTimeout(flush, flushMs);
    }
    pending.push(change);
    if (flushTimer) {
      clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(flush, debounceMs);
  };

  const classify = async (path: string, type: FileChangeType): Promise<FileChange | undefined> => {
    if (path === dir) {
      return undefined;
    }
    let isDirectory = false;
    let exists = true;
    try {
      const info = await lstat(path);
      isDirectory = info.isDirectory();
      if (isDirectory) {
        seenDirectories.add(path);
      }
    } catch {
      exists = false;
      if (seenDirectories.delete(path)) {
        isDirectory = true;
      }
    }
    if (type === "deleted") {
      return { path, type, isDirectory };
    }
    // 事件与 lstat 之间的竞态：目标已消失按删除处理
    if (!exists) {
      return { path, type: "deleted", isDirectory };
    }
    if (isDirectory) {
      return undefined;
    }
    return { path, type, isDirectory };
  };

  /** 逐事件分类与忽略过滤；订阅路径不等待，轮询路径等待以避免两轮重叠。 */
  const processEvents = async (events: ParcelWatcherEvent[]): Promise<void> => {
    for (const event of events) {
      if (stopped) {
        return;
      }
      const path = normalize(event.path);
      const type: FileChangeType =
        event.type === "create" ? "created" : event.type === "update" ? "changed" : "deleted";
      const change = await classify(path, type);
      if (!change) {
        continue;
      }
      if (isIgnored(change.path, dir, ignorePatterns)) {
        continue;
      }
      push(change);
    }
  };

  const ignoreOptions = (): { ignore: string[] } => ({
    ignore: [...ignorePatterns, ...ignoreDirs],
  });

  const stopPolling = (): void => {
    if (!pollingTimer) {
      return;
    }
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  };

  const removeSnapshot = async (): Promise<void> => {
    const file = snapshotFile;
    snapshotFile = undefined;
    if (file) {
      await Promise.all(
        [file, `${file}.next`].map((path) =>
          rm(path, { force: true }).catch(() => {
            // 清理失败不影响流程
          }),
        ),
      );
    }
  };

  /** 快照读写失败后停止轮询并回落到监听器停用。 */
  const failPolling = (error: unknown): void => {
    stopPolling();
    void removeSnapshot();
    if (!stopped) {
      options?.onError?.(`workspace watcher polling failed for ${dir}: ${String(error)}`);
    }
  };

  async function poll(): Promise<void> {
    if (stopped || pollingRunning || !snapshotFile) {
      return;
    }
    pollingRunning = true;
    try {
      // 先用新快照扫描、再与旧基线比较、最后原子替换：两次扫描之间的修改
      // 会在下一轮被旧基线捕获（可能重复报告一次，但不会丢），
      // 而 getEventsSince 后直接重写快照会吞掉这段窗口内的修改。
      const nextSnapshot = `${snapshotFile}.next`;
      await writeSnapshot(dir, nextSnapshot, ignoreOptions());
      const events = await getEventsSince(dir, snapshotFile, ignoreOptions());
      await rename(nextSnapshot, snapshotFile);
      await processEvents(events);
    } catch (error) {
      failPolling(error);
    } finally {
      pollingRunning = false;
    }
  }

  /** 订阅因资源耗尽失败时建立快照基线并开始轮询。 */
  async function startPolling(): Promise<void> {
    if (
      stopped ||
      pollingStarting ||
      pollingTimer !== undefined ||
      pollingIntervalMs === undefined
    ) {
      return;
    }
    pollingStarting = true;
    try {
      const file = snapshotPathFor(dir);
      await mkdir(dirname(file), { recursive: true });
      await writeSnapshot(dir, file, ignoreOptions());
      snapshotFile = file;
      if (isStopped()) {
        await removeSnapshot();
        return;
      }
      if (!degradedNotified) {
        degradedNotified = true;
        options?.onDegraded?.(
          `inotify watch limit hit for ${dir}; falling back to polling every ${pollingIntervalMs}ms (raise fs.inotify.max_user_watches and run /lsp-reload to restore event-driven watching)`,
        );
      }
      pollingTimer = setInterval(() => {
        void poll();
      }, pollingIntervalMs);
      pollingTimer.unref();
    } catch (error) {
      options?.onError?.(`workspace watcher polling failed for ${dir}: ${String(error)}`);
    } finally {
      pollingStarting = false;
    }
  }

  const handleError = (error: unknown): void => {
    if (stopped) {
      return;
    }
    const message = `workspace watcher failed for ${dir}: ${String(error)}`;
    if (pollingIntervalMs !== undefined && EXHAUSTED_ERROR.test(message)) {
      void startPolling();
      return;
    }
    options?.onError?.(message);
  };

  const handleEvents = (error: Error | null, events: ParcelWatcherEvent[]): void => {
    if (error) {
      handleError(error);
      return;
    }
    void processEvents(events);
  };

  async function startSubscription(): Promise<void> {
    try {
      subscription = await subscribe(dir, handleEvents, {
        ignore: [...ignorePatterns, ...ignoreDirs],
      });
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
      stopPolling();
      if (subscription) {
        try {
          await subscription.unsubscribe();
        } catch {
          // 订阅已失败或重复 stop
        }
        subscription = undefined;
      }
      await started;
      await removeSnapshot();
    },
  }));
}
