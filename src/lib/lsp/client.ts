/**
 * LSP 客户端：单条语言服务器连接的封装（移植自 opencode lsp/client.ts）。
 *
 * - vscode-jsonrpc 消息连接 + initialize/initialized 握手；
 * - didOpen / didChange（按服务器 textDocumentSync 适配增量或全量）；
 * - 诊断双通道：push（textDocument/publishDiagnostics）+ pull
 *   （textDocument/diagnostic、workspace/diagnostic，支持动态注册）；
 * - waitForDiagnostics：document 模式最多等 5s、full 模式最多等 10s，
 *   push 通知带 150ms debounce，pull 请求 3s 超时。
 */

import { readFile } from "node:fs/promises";
import { extname, isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createMessageConnection,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { Diagnostic as VSCodeDiagnostic, WorkspaceEdit } from "vscode-languageserver-types";

import type { LspServerHandle } from "./adapter.js";
import { LANGUAGE_EXTENSIONS } from "./language.js";
import { editFilePaths } from "./rename.js";
import type { FileChange, FileChangeType } from "./watcher.js";

// LSP spec 常量
const FILE_CHANGE_CREATED = 1;
const FILE_CHANGE_CHANGED = 2;
const FILE_CHANGE_DELETED = 3;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;

/** LSP WatchKind 位掩码（FileSystemWatcher.kind，缺省 create|change|delete）。 */
export const WATCH_KIND_CREATE = 1;
export const WATCH_KIND_CHANGE = 2;
export const WATCH_KIND_DELETE = 4;
const WATCH_KIND_ALL = WATCH_KIND_CREATE | WATCH_KIND_CHANGE | WATCH_KIND_DELETE;

/** 服务器通过 client/registerCapability 注册的单个 watcher。 */
export interface WatcherGlob {
  pattern: string;
  kind: number;
}

const FILE_CHANGE_TYPE: Record<FileChangeType, number> = {
  created: FILE_CHANGE_CREATED,
  changed: FILE_CHANGE_CHANGED,
  deleted: FILE_CHANGE_DELETED,
};

export type Diagnostic = VSCodeDiagnostic;

/** 两个路径集合是否一致（用于判断 references 结果是否收敛）。 */
function samePaths(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const path of a) if (!b.has(path)) return false;
  return true;
}

/** LSP MethodNotFound（-32601）：服务器未实现 prepareRename / rename 请求。 */
const LSP_METHOD_NOT_FOUND = -32601;

/**
 * 位置不可 rename 或服务器不具备 rename 能力；与传输失败等意外错误区分，
 * 供调用方在多候选探测时跳过该 client 而不是中断整个操作。
 */
export class RenameNotPossibleError extends Error {}

/**
 * rename edit 未覆盖 references 看到的全部文件：服务器索引可能仍在后台加载。
 * 抛出时发生在写盘之前，整个 rename 无副作用，可稍后重试。
 */
export class RenameIncompleteError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(
      `LSP rename incomplete: textDocument/references found the symbol in ` +
        `${missing.length} file(s) that the rename edit does not cover ` +
        `(${missing.join(", ")}). The server index may still be loading; ` +
        `nothing was modified, retry shortly.`,
    );
    this.missing = missing;
  }
}

/**
 * rename 覆盖校验的轮询节奏。budgetMs 是 references 收敛 + 重试的总预算；
 * 测试可临时缩小以缩短等待。
 */
export const renameVerificationTiming = { pollMs: 400, budgetMs: 10_000 };

interface PrepareRenameResponse {
  range?: unknown;
  placeholder?: string;
  defaultBehavior?: boolean;
}

/** renameSymbol 的请求与结果（line / character 为 0-based LSP position）。 */
export interface RenameSymbolRequest {
  path: string;
  line: number;
  character: number;
  newName: string;
}

export interface RenameSymbolResult {
  edit: WorkspaceEdit;
  /** prepareRename 返回的符号当前名；服务器未提供 prepare 时缺省。 */
  placeholder?: string;
}

export class InitializeError extends Error {
  readonly serverID: string;
  constructor(serverID: string, cause: unknown) {
    super(`Failed to initialize LSP server ${serverID}`, { cause });
    this.serverID = serverID;
  }
}

interface DocumentDiagnosticReport {
  items?: Diagnostic[];
  relatedDocuments?: Record<string, DocumentDiagnosticReport>;
}

interface WorkspaceDiagnosticReport {
  items?: { uri?: string; items?: Diagnostic[] }[];
}

interface DiagnosticRequestResult {
  handled: boolean;
  matched: boolean;
  byFile: Map<string, Diagnostic[]>;
  /** 单次请求是否超时（区别于正常失败：超时意味着服务器未响应，不应重试）。 */
  timedOut: boolean;
}

/** 一批 pull 请求的聚合结果；timedOut 表示其中至少一个请求超时。 */
interface PullResult {
  handled: boolean;
  matched: boolean;
  timedOut: boolean;
}

interface CapabilityRegistration {
  id: string;
  method: string;
  registerOptions?: {
    identifier?: string;
    workspaceDiagnostics?: boolean;
    watchers?: { globPattern?: string; kind?: number }[];
  };
}

interface ServerCapabilities {
  textDocumentSync?:
    | number
    | {
        change?: number;
      };
  diagnosticProvider?: unknown;
  renameProvider?: boolean | { prepareProvider?: boolean };
  [key: string]: unknown;
}

export interface CreateInput {
  serverID: string;
  server: LspServerHandle;
  root: string;
  directory: string;
  /** 可覆盖的超时参数（缺省用 client 默认值，由全局/本地 lsp.json 配置注入）。 */
  diagnosticsDebounceMs?: number;
  diagnosticsDocumentWaitTimeoutMs?: number;
  diagnosticsFullWaitTimeoutMs?: number;
  diagnosticsRequestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  /** 驻留文档上限（LRU 容量，缺省 32）；超过时淘汰最久未使用并 didClose。 */
  maxOpenDocuments?: number;
}

export interface LspClient {
  readonly root: string;
  readonly serverID: string;
  readonly connection: MessageConnection;
  readonly notify: {
    open(request: { path: string }): Promise<number>;
    /** 把工作区文件事件批量通知服务器；驻留文档不在此通道（走 didOpen/didChange/退场）。 */
    watchedFiles(changes: FileChange[]): Promise<void>;
  };
  /** 服务器注册的 workspace/didChangeWatchedFiles watchers（pattern + kind，按 pattern+kind 去重）。 */
  watchers(): WatcherGlob[];
  readonly diagnostics: Map<string, Diagnostic[]>;
  waitForDiagnostics(request: {
    path: string;
    version: number;
    mode?: "document" | "full";
    after?: number;
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * 符号重命名：先把磁盘内容同步给服务器（didOpen/didChange），再按能力决定
   * 是否先发 prepareRename 校验位置，最后发 textDocument/rename 返回 WorkspaceEdit。
   * 位置不在符号上 / 服务器不支持 rename 时抛 RenameNotPossibleError。
   */
  renameSymbol(request: RenameSymbolRequest): Promise<RenameSymbolResult>;
  shutdown(): Promise<void>;
}

export type Info = LspClient;

function getFilePath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  return normalize(fileURLToPath(uri));
}

function getSyncKind(capabilities?: ServerCapabilities): number | undefined {
  if (!capabilities) return undefined;
  const sync = capabilities.textDocumentSync;
  if (typeof sync === "number") return sync;
  return sync?.change;
}

function hasCurrentFileDiagnostics(filePath: string, results: DiagnosticRequestResult[]) {
  return results.some((result) => (result.byFile.get(filePath)?.length ?? 0) > 0);
}

function endPosition(text: string): { line: number; character: number } {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  };
}

function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function configurationValue(settings: unknown, section?: string): unknown {
  if (!section) return settings ?? null;
  const result = section.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || !(key in acc)) return;
    return (acc as Record<string, unknown>)[key];
  }, settings);
  return result ?? null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** pull 诊断失败后的重试间隔。 */
const PULL_RETRY_INTERVAL_MS = 100;

function stopProcess(process: LspServerHandle["process"]): Promise<void> {
  if (process.exitCode !== null) return Promise.resolve();
  try {
    process.kill();
  } catch {
    // Windows 上对已退出/从未成功启动的进程 kill 会抛 EINVAL
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    process.once("exit", () => resolve());
    process.once("error", () => resolve());
    setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch {
        // 进程已退出，忽略
      }
    }, 1_000).unref();
  });
}

export async function create(input: CreateInput): Promise<LspClient> {
  const diagnosticsDebounceMs = input.diagnosticsDebounceMs ?? 150;
  const diagnosticsDocumentWaitTimeoutMs = input.diagnosticsDocumentWaitTimeoutMs ?? 5_000;
  const diagnosticsFullWaitTimeoutMs = input.diagnosticsFullWaitTimeoutMs ?? 10_000;
  const diagnosticsRequestTimeoutMs = input.diagnosticsRequestTimeoutMs ?? 3_000;
  const initializeTimeoutMs = input.initializeTimeoutMs ?? 45_000;
  const maxOpenDocuments = input.maxOpenDocuments ?? 32;

  const connection = createMessageConnection(
    new StreamMessageReader(input.server.process.stdout),
    new StreamMessageWriter(input.server.process.stdin),
  );
  input.server.process.stderr?.resume();
  /** 连接或服务器进程已关闭；pull 重试循环以此终止，避免无界等待。 */
  let connectionClosed = false;
  input.server.process.once("exit", () => {
    connectionClosed = true;
  });
  connection.onDispose(() => {
    connectionClosed = true;
  });

  // ── 连接状态 ────────────────────────────────────────────────────────────────

  const pushDiagnostics = new Map<string, Diagnostic[]>();
  const pullDiagnostics = new Map<string, Diagnostic[]>();
  const published = new Map<string, { at: number; version?: number }>();
  const diagnosticRegistrations = new Map<string, CapabilityRegistration>();
  /** registration id → workspace/didChangeWatchedFiles watchers（pattern + WatchKind 位）。 */
  const watcherRegistrations = new Map<string, WatcherGlob[]>();
  const registrationListeners = new Set<() => void>();
  const diagnosticListeners = new Set<(input: { path: string; serverID: string }) => void>();
  /** resolvedPath → 客户端已发送的最新文档版本（didOpen=0，didChange 递增）。 */
  const documentVersions = new Map<string, number>();
  const mergedDiagnostics = (filePath: string): Diagnostic[] =>
    dedupeDiagnostics([
      ...(pushDiagnostics.get(filePath) ?? []),
      ...(pullDiagnostics.get(filePath) ?? []),
    ]);
  const updatePushDiagnostics = (filePath: string, next: Diagnostic[]): void => {
    pushDiagnostics.set(filePath, next);
    for (const listener of diagnosticListeners)
      listener({ path: filePath, serverID: input.serverID });
  };
  const updatePullDiagnostics = (filePath: string, next: Diagnostic[]): void => {
    pullDiagnostics.set(filePath, next);
  };
  const emitRegistrationChange = (): void => {
    for (const listener of registrationListeners) listener();
  };

  // ── LSP 连接处理器 ─────────────────────────────────────────────────────────

  connection.onNotification(
    "textDocument/publishDiagnostics",
    (params: { uri: string; version?: number; diagnostics: Diagnostic[] }) => {
      const filePath = getFilePath(params.uri);
      if (!filePath) return;
      // 服务器版本滞后于已发送版本时，该 push 对应的是旧内容（异步重算未完成
      // 时的迟到结果）。忽略，避免与当前版本结果混淆。
      const currentVersion = documentVersions.get(filePath);
      const isStalePush =
        typeof params.version === "number" &&
        currentVersion !== undefined &&
        params.version !== currentVersion;
      if (isStalePush) return;
      published.set(filePath, {
        at: Date.now(),
        version: typeof params.version === "number" ? params.version : undefined,
      });
      updatePushDiagnostics(filePath, params.diagnostics);
    },
  );
  connection.onRequest("window/workDoneProgress/create", () => null);
  connection.onRequest("workspace/configuration", (params) => {
    const items = (params as { items?: { section?: string }[] }).items ?? [];
    return items.map((item) =>
      configurationValue(input.server.settings ?? input.server.initialization, item.section),
    );
  });
  connection.onRequest("client/registerCapability", (params) => {
    const registrations =
      (params as { registrations?: CapabilityRegistration[] }).registrations ?? [];
    let changed = false;
    for (const registration of registrations) {
      if (registration.method === "workspace/didChangeWatchedFiles") {
        const watchers =
          registration.registerOptions?.watchers
            ?.map((watcher) => ({
              pattern: watcher.globPattern,
              kind: watcher.kind ?? WATCH_KIND_ALL,
            }))
            .filter((watcher): watcher is WatcherGlob => typeof watcher.pattern === "string") ?? [];
        watcherRegistrations.set(registration.id, watchers);
      } else if (registration.method === "textDocument/diagnostic") {
        diagnosticRegistrations.set(registration.id, registration);
        changed = true;
      }
    }
    if (changed) emitRegistrationChange();
  });
  connection.onRequest("client/unregisterCapability", (params) => {
    const registrations =
      (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? [];
    let changed = false;
    for (const registration of registrations) {
      if (registration.method === "workspace/didChangeWatchedFiles") {
        watcherRegistrations.delete(registration.id);
      } else if (registration.method === "textDocument/diagnostic") {
        diagnosticRegistrations.delete(registration.id);
        changed = true;
      }
    }
    if (changed) emitRegistrationChange();
  });
  connection.onRequest("workspace/workspaceFolders", () => [
    { name: "workspace", uri: pathToFileURL(input.root).href },
  ]);
  connection.onRequest("workspace/diagnostic/refresh", () => null);
  connection.listen();

  // ── initialize 握手 ─────────────────────────────────────────────────────────

  const initialized = await withTimeout(
    connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
      rootUri: pathToFileURL(input.root).href,
      processId: input.server.process.pid,
      workspaceFolders: [{ name: "workspace", uri: pathToFileURL(input.root).href }],
      initializationOptions: {
        ...input.server.initialization,
      },
      capabilities: {
        window: { workDoneProgress: true },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          diagnostics: { refreshSupport: false },
        },
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
          publishDiagnostics: { versionSupport: false },
        },
      },
    }),
    initializeTimeoutMs,
  ).catch(async (error: unknown) => {
    // 握手失败（超时/拒绝）时清理连接并终止已 spawn 的子进程，避免进程泄漏
    connection.end();
    connection.dispose();
    await stopProcess(input.server.process);
    throw new InitializeError(input.serverID, error);
  });

  const syncKind = getSyncKind(initialized.capabilities);
  const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider);
  // prepareProvider 只在静态声明为对象且显式开启时使用；其余情况跳过 prepare
  // 直接 rename（能力可能经动态注册，静态声明缺失不代表服务器不支持）。
  const renameProvider = initialized.capabilities?.renameProvider;
  const hasPrepareProvider =
    typeof renameProvider === "object" && renameProvider.prepareProvider === true;

  await connection.sendNotification("initialized", {});

  const settings = input.server.settings ?? input.server.initialization;
  if (settings) {
    await connection.sendNotification("workspace/didChangeConfiguration", { settings });
  }

  const files: Record<string, { version: number; text: string }> = {};

  // ── 驻留 LRU ────────────────────────────────────────────────────────────────

  /** path → 最近使用时间；迭代序即使用序（头部最久）。 */
  const lruOrder = new Map<string, number>();
  /** 正在等待诊断的文档（didClose 淘汰时跳过，见"关闭不得早于诊断收集"）。 */
  const waitingForDiagnostics = new Set<string>();

  const touch = (path: string): void => {
    lruOrder.delete(path);
    lruOrder.set(path, Date.now());
  };

  /** 超过容量时淘汰最久未使用的文档（didClose 并移出驻留集合）。 */
  async function evictExcess(): Promise<void> {
    while (lruOrder.size > maxOpenDocuments) {
      const oldest = lruOrder.keys().next().value;
      if (oldest === undefined) return;
      lruOrder.delete(oldest);
      const document = files[oldest];
      if (document === undefined) continue;
      if (waitingForDiagnostics.has(oldest)) {
        // 防御：等待中的文档挪到 MRU，等下轮再淘汰（正常不会发生，刚 touch 即 MRU）
        touch(oldest);
        continue;
      }
      await connection.sendNotification("textDocument/didClose", {
        textDocument: { uri: pathToFileURL(oldest).href },
      });
      delete files[oldest];
      documentVersions.delete(oldest);
    }
  }

  // ── 诊断拉取（pull）辅助 ────────────────────────────────────────────────────

  const mergeResults = (filePath: string, results: DiagnosticRequestResult[]): PullResult => {
    if (results.every((result) => !result.handled)) {
      return {
        handled: false,
        matched: false,
        timedOut: results.some((result) => result.timedOut),
      };
    }
    const matched = results.some((result) => result.matched);
    const timedOut = results.some((result) => result.timedOut);

    const merged = new Map<string, Diagnostic[]>();
    for (const result of results) {
      for (const [target, items] of result.byFile) {
        const existing = merged.get(target) ?? [];
        merged.set(target, [...existing, ...items]);
      }
    }

    if (matched && !merged.has(filePath)) merged.set(filePath, []);
    for (const [target, items] of merged) {
      updatePullDiagnostics(target, dedupeDiagnostics(items));
    }

    return { handled: true, matched, timedOut };
  };

  async function requestDiagnosticReport(
    filePath: string,
    identifier?: string,
  ): Promise<DiagnosticRequestResult> {
    let timedOut = false;
    const report = await withTimeout(
      connection.sendRequest<DocumentDiagnosticReport | null>("textDocument/diagnostic", {
        ...(identifier && { identifier }),
        textDocument: { uri: pathToFileURL(filePath).href },
      }),
      diagnosticsRequestTimeoutMs,
    ).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("Timeout after")) timedOut = true;
      return null;
    });
    if (!report) {
      return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>(), timedOut };
    }

    const byFile = new Map<string, Diagnostic[]>();
    const push = (target: string, items: Diagnostic[]): void => {
      const existing = byFile.get(target) ?? [];
      byFile.set(target, [...existing, ...items]);
    };

    let handled = false;
    let matched = false;
    if (Array.isArray(report.items)) {
      push(filePath, report.items);
      handled = true;
      matched = true;
    }
    for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedPath = getFilePath(uri);
      if (!relatedPath || !Array.isArray(related.items)) continue;
      push(relatedPath, related.items);
      handled = true;
      matched ||= relatedPath === filePath;
    }

    return { handled, matched, byFile, timedOut };
  }

  async function requestWorkspaceDiagnosticReport(
    filePath: string,
    identifier?: string,
  ): Promise<DiagnosticRequestResult> {
    let timedOut = false;
    const report = await withTimeout(
      connection.sendRequest<WorkspaceDiagnosticReport | null>("workspace/diagnostic", {
        ...(identifier && { identifier }),
        previousResultIds: [],
      }),
      diagnosticsRequestTimeoutMs,
    ).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("Timeout after")) timedOut = true;
      return null;
    });
    if (!report) {
      return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>(), timedOut };
    }

    const byFile = new Map<string, Diagnostic[]>();
    let matched = false;
    for (const item of report.items ?? []) {
      const relatedPath = item.uri ? getFilePath(item.uri) : undefined;
      if (!relatedPath || !Array.isArray(item.items)) continue;
      const existing = byFile.get(relatedPath) ?? [];
      byFile.set(relatedPath, [...existing, ...item.items]);
      matched ||= relatedPath === filePath;
    }

    return { handled: true, matched, byFile, timedOut };
  }

  function documentPullState() {
    const documentRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics !== true,
    );
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap((r) => r.registerOptions?.identifier ?? [])),
      ],
      supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
    };
  }

  function workspacePullState() {
    const workspaceRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics === true,
    );
    return {
      workspaceIdentifiers: [
        ...new Set(workspaceRegistrations.flatMap((r) => r.registerOptions?.identifier ?? [])),
      ],
      supported: workspaceRegistrations.length > 0,
    };
  }

  async function requestDiagnostics(
    filePath: string,
    requests: Promise<DiagnosticRequestResult>[],
    done: (results: DiagnosticRequestResult[]) => boolean,
  ): Promise<PullResult> {
    if (requests.length === 0) return { handled: false, matched: false, timedOut: false };

    return new Promise<PullResult>((resolve) => {
      const results: DiagnosticRequestResult[] = [];
      let pending = requests.length;
      let resolved = false;
      const finish = (merged: PullResult, force = false) => {
        if (resolved) return;
        if (!force && !done(results)) return;
        resolved = true;
        resolve(merged);
      };

      for (const request of requests) {
        void request
          .then((result) => {
            results.push(result);
            pending -= 1;
            const merged = mergeResults(filePath, results);
            finish(merged);
            if (pending === 0) finish(merged, true);
            return;
          })
          .catch(() => {
            pending -= 1;
            if (pending === 0) finish(mergeResults(filePath, results), true);
            return;
          });
      }
    });
  }

  // 并发发起 identifier pull，一旦某批已产出当前文件诊断即可放行；
  // 慢的 pull 继续在后台合并，不按 identifier 串行。见 opencode PR #23771。
  async function requestDocumentDiagnostics(filePath: string): Promise<PullResult> {
    const state = documentPullState();
    if (!state.supported) return { handled: false, matched: false, timedOut: false };
    return requestDiagnostics(
      filePath,
      [
        requestDiagnosticReport(filePath),
        ...state.documentIdentifiers.map((identifier) =>
          requestDiagnosticReport(filePath, identifier),
        ),
      ],
      (results) => hasCurrentFileDiagnostics(filePath, results),
    );
  }

  async function requestFullDiagnostics(filePath: string): Promise<PullResult> {
    const documentState = documentPullState();
    const workspaceState = workspacePullState();
    if (!documentState.supported && !workspaceState.supported) {
      return { handled: false, matched: false, timedOut: false };
    }
    return mergeResults(
      filePath,
      await Promise.all([
        ...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
        ...documentState.documentIdentifiers.map((identifier) =>
          requestDiagnosticReport(filePath, identifier),
        ),
        ...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
        ...workspaceState.workspaceIdentifiers.map((identifier) =>
          requestWorkspaceDiagnosticReport(filePath, identifier),
        ),
      ]),
    );
  }

  function waitForRegistrationChange(timeout: number): Promise<boolean> {
    if (timeout <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const finish = (result: boolean) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        registrationListeners.delete(listener);
        resolve(result);
      };
      const listener = () => finish(true);
      registrationListeners.add(listener);
      const timer = setTimeout(() => finish(false), timeout);
    });
  }

  function waitForFreshPush(request: {
    path: string;
    version: number;
    after: number;
    timeout: number;
  }): Promise<boolean> {
    if (request.timeout <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: boolean) => {
        if (finished) return;
        finished = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unsub?.();
        resolve(result);
      };
      const schedule = () => {
        const hit = published.get(request.path);
        if (!hit) return;
        if (typeof hit.version === "number" && hit.version !== request.version) return;
        if (hit.at < request.after && hit.version !== request.version) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(
          () => finish(true),
          Math.max(0, diagnosticsDebounceMs - (Date.now() - hit.at)),
        );
      };

      const timeoutTimer = setTimeout(() => finish(false), request.timeout);
      const listener = (event: { path: string; serverID: string }) => {
        if (event.path !== request.path || event.serverID !== input.serverID) return;
        schedule();
      };
      diagnosticListeners.add(listener);
      const unsub = () => diagnosticListeners.delete(listener);
      schedule();
    });
  }

  async function waitForDocumentDiagnostics(request: {
    path: string;
    version: number;
    after?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const startedAt = request.after ?? Date.now();
    // pull 与 push 语义相同：都是等「当前文档版本」的诊断结果，统一一个循环。
    // 先 pull（拿到即返回）；pull 超时说明服务器未响应，不再重试 pull，只等
    // 版本匹配的 push 兜底；版本不匹配的 push 一律忽略（防迟到旧结果）。
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: diagnosticsDocumentWaitTimeoutMs,
    });

    while (!connectionClosed && !request.signal?.aborted) {
      const remaining = diagnosticsDocumentWaitTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) return;
      const result = await requestDocumentDiagnostics(request.path);
      if (result.matched) return;
      if (result.timedOut) {
        await pushWait;
        return;
      }
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? ("push" as const) : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) =>
          changed ? ("registration" as const) : ("timeout" as const),
        ),
        sleep(Math.min(remaining, PULL_RETRY_INTERVAL_MS)).then(() => "interval" as const),
      ]);
      if (next === "push") return;
    }
  }

  async function waitForFullDiagnostics(request: {
    path: string;
    version: number;
    after?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const startedAt = request.after ?? Date.now();
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: diagnosticsFullWaitTimeoutMs,
    });

    while (!connectionClosed && !request.signal?.aborted) {
      const remaining = diagnosticsFullWaitTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) return;
      const result = await requestFullDiagnostics(request.path);
      if (result.handled || result.matched) return;
      if (result.timedOut) {
        await pushWait;
        return;
      }
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? ("push" as const) : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) =>
          changed ? ("registration" as const) : ("timeout" as const),
        ),
        sleep(Math.min(remaining, PULL_RETRY_INTERVAL_MS)).then(() => "interval" as const),
      ]);
      if (next === "push") return;
    }
  }

  // ── 公开 API ────────────────────────────────────────────────────────────────

  const openDocument = async (request: { path: string }): Promise<number> => {
    const resolvedPath = normalize(
      isAbsolute(request.path) ? request.path : resolve(input.directory, request.path),
    );
    const text = await readFile(resolvedPath, "utf8");
    const extension = extname(resolvedPath);
    const languageId =
      input.server.languageIds?.[extension] ?? LANGUAGE_EXTENSIONS[extension] ?? "plaintext";
    const uri = pathToFileURL(resolvedPath).href;

    const document = files[resolvedPath];
    if (document !== undefined) {
      // didChange：内容已变，旧诊断立即失效。清空缓存避免等待窗口内服务器
      // 重算未完成时（大项目可远超窗口）聚合到过期诊断；新 push 到达即填充。
      pushDiagnostics.delete(resolvedPath);
      pullDiagnostics.delete(resolvedPath);

      const next = document.version + 1;
      files[resolvedPath] = { version: next, text };
      documentVersions.set(resolvedPath, next);
      await connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: next },
        contentChanges:
          syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
            ? [
                {
                  range: { start: { line: 0, character: 0 }, end: endPosition(document.text) },
                  text,
                },
              ]
            : [{ text }],
      });
      touch(resolvedPath);
      await evictExcess();
      return next;
    }

    pushDiagnostics.delete(resolvedPath);
    pullDiagnostics.delete(resolvedPath);
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 0, text },
    });
    files[resolvedPath] = { version: 0, text };
    documentVersions.set(resolvedPath, 0);
    touch(resolvedPath);
    await evictExcess();
    return 0;
  };

  return {
    root: input.root,
    get serverID() {
      return input.serverID;
    },
    watchers(): WatcherGlob[] {
      return [
        ...new Set(
          [...watcherRegistrations.values()].flat().map((w) => JSON.stringify([w.pattern, w.kind])),
        ),
      ].map((key) => {
        const [pattern, kind] = JSON.parse(key) as [string, number];
        return { pattern, kind };
      });
    },
    get connection() {
      return connection;
    },
    notify: {
      open: openDocument,
      async watchedFiles(changes: FileChange[]): Promise<void> {
        const notified: { uri: string; type: number }[] = [];
        for (const change of changes) {
          const resolvedPath = normalize(
            isAbsolute(change.path) ? change.path : resolve(input.directory, change.path),
          );
          const document = files[resolvedPath];
          if (document !== undefined) {
            // 写后诊断等待中的文档不退场（didClose 可能抹掉本次写入的诊断结果）
            if (waitingForDiagnostics.has(resolvedPath)) continue;
            // 驻留文档被外部改动：内容一致的自身写入 echo 完全忽略；否则先 didClose
            // 让服务器回落磁盘，再以文件事件通知——不 bump 版本，避免与写后等待竞态。
            if (change.type === "changed") {
              let disk: string | undefined;
              try {
                disk = await readFile(resolvedPath, "utf8");
              } catch {
                // 文件已被删除或不可读：按磁盘状态变化处理
              }
              if (disk === document.text) continue;
            }
            await connection.sendNotification("textDocument/didClose", {
              textDocument: { uri: pathToFileURL(resolvedPath).href },
            });
            delete files[resolvedPath];
            documentVersions.delete(resolvedPath);
          }
          notified.push({
            uri: pathToFileURL(resolvedPath).href,
            type: FILE_CHANGE_TYPE[change.type],
          });
        }
        if (notified.length === 0) return;
        await connection.sendNotification("workspace/didChangeWatchedFiles", {
          changes: notified,
        });
      },
    },
    async renameSymbol(request: RenameSymbolRequest): Promise<RenameSymbolResult> {
      const resolvedPath = normalize(
        isAbsolute(request.path) ? request.path : resolve(input.directory, request.path),
      );
      const uri = pathToFileURL(resolvedPath).href;
      // rename 前强制同步磁盘内容，保证服务器基于最新文本计算编辑
      await openDocument({ path: resolvedPath });
      const position = { line: request.line, character: request.character };
      const at = `${resolvedPath}:${request.line + 1}:${request.character + 1}`;
      const notRenameable = () =>
        new RenameNotPossibleError(`LSP server "${input.serverID}" cannot rename at ${at}`);

      // references 前置 + rename 覆盖校验：LSP 没有标准化的"索引完成"信号，
      // 服务器（如 tsserver）可能在项目加载完成前回答，导致 rename 漏掉
      // 尚未入索引的文件。对策分两层：
      // 1. 收敛检测：references 连续两次文件集合一致才认为索引稳定，防止
      //    "服务器根本还没发现某文件"时校验形同虚设；
      // 2. 覆盖校验：references 报告的文件必须都被 rename edit 覆盖，
      //    不完整时等待重试，预算耗尽仍不完整抛 RenameIncompleteError——
      //    调用方尚未写盘，整个操作无副作用，可稍后重试。
      // 服务器不支持 references（MethodNotFound）时跳过校验，信任服务器，
      // 与编辑器行为一致。
      const referencesRequest = () =>
        connection.sendRequest<{ uri: string }[] | null>("textDocument/references", {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },
        });

      const toPaths = (locations: { uri: string }[] | null): Set<string> =>
        new Set(
          (locations ?? []).flatMap((location) =>
            location.uri.startsWith("file:") ? [normalize(fileURLToPath(location.uri))] : [],
          ),
        );

      const sendRename = async (): Promise<WorkspaceEdit | null> => {
        try {
          return await connection.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
            textDocument: { uri },
            position,
            newName: request.newName,
          });
        } catch (error) {
          if (error instanceof ResponseError && error.code === LSP_METHOD_NOT_FOUND) {
            throw notRenameable();
          }
          throw error;
        }
      };

      let placeholder: string | undefined;
      if (hasPrepareProvider) {
        let prepared: PrepareRenameResponse | null;
        try {
          prepared = await connection.sendRequest<PrepareRenameResponse | null>(
            "textDocument/prepareRename",
            { textDocument: { uri }, position },
          );
        } catch (error) {
          if (error instanceof ResponseError && error.code === LSP_METHOD_NOT_FOUND) {
            throw notRenameable();
          }
          throw error;
        }
        if (!prepared) throw notRenameable();
        if (typeof prepared.placeholder === "string") placeholder = prepared.placeholder;
      }

      let locations: { uri: string }[] | null;
      try {
        locations = await referencesRequest();
      } catch (error) {
        if (!(error instanceof ResponseError && error.code === LSP_METHOD_NOT_FOUND)) throw error;
        const edit = await sendRename();
        if (!edit) throw notRenameable();
        return placeholder === undefined ? { edit } : { edit, placeholder };
      }

      const deadline = Date.now() + renameVerificationTiming.budgetMs;
      let previous: Set<string> | undefined;
      let current = toPaths(locations);
      for (;;) {
        const settled = previous !== undefined && samePaths(previous, current);
        if (settled || Date.now() >= deadline) {
          const edit = await sendRename();
          if (!edit) throw notRenameable();
          const missing = [...current].filter((path) => !editFilePaths(edit).has(path));
          if (missing.length === 0) {
            return placeholder === undefined ? { edit } : { edit, placeholder };
          }
          throw new RenameIncompleteError(missing);
        }
        previous = current;
        await sleep(renameVerificationTiming.pollMs);
        current = toPaths(await referencesRequest());
      }
    },
    get diagnostics() {
      const result = new Map<string, Diagnostic[]>();
      for (const key of new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])) {
        result.set(key, mergedDiagnostics(key));
      }
      return result;
    },
    async waitForDiagnostics(request) {
      const normalizedPath = normalize(
        isAbsolute(request.path) ? request.path : resolve(input.directory, request.path),
      );
      waitingForDiagnostics.add(normalizedPath);
      try {
        if (request.mode === "document") {
          await waitForDocumentDiagnostics({
            path: normalizedPath,
            version: request.version,
            after: request.after,
            signal: request.signal,
          });
          return;
        }
        await waitForFullDiagnostics({
          path: normalizedPath,
          version: request.version,
          after: request.after,
          signal: request.signal,
        });
      } finally {
        waitingForDiagnostics.delete(normalizedPath);
      }
    },
    async shutdown() {
      connection.end();
      connection.dispose();
      await stopProcess(input.server.process);
    },
  };
}
