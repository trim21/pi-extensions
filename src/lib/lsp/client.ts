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
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types";

import type { LspServerHandle } from "./adapter.js";
import { LANGUAGE_EXTENSIONS } from "./language.js";

// LSP spec 常量
const FILE_CHANGE_CREATED = 1;
const FILE_CHANGE_CHANGED = 2;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;

export type Diagnostic = VSCodeDiagnostic;

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
  };
}

interface ServerCapabilities {
  textDocumentSync?:
    | number
    | {
        change?: number;
      };
  diagnosticProvider?: unknown;
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
}

export interface LspClient {
  readonly root: string;
  readonly serverID: string;
  readonly connection: MessageConnection;
  readonly notify: {
    open(request: { path: string }): Promise<number>;
  };
  readonly diagnostics: Map<string, Diagnostic[]>;
  waitForDiagnostics(request: {
    path: string;
    version: number;
    mode?: "document" | "full";
    after?: number;
    signal?: AbortSignal;
  }): Promise<void>;
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
      // 支持 pull 诊断的服务器：push 的结果可能来自旧内容（异步重算迟到），
      // 直接忽略，只信任 pull 返回的当前文档结果，从源头避免 stale。
      if (supportsPullDiagnostics()) return;
      // 纯 push 服务器：服务器版本滞后于已发送版本时，该 push 对应的是旧内容
      // （重算未完成时的迟到结果），同样忽略。
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
      if (registration.method !== "textDocument/diagnostic") continue;
      diagnosticRegistrations.set(registration.id, registration);
      changed = true;
    }
    if (changed) emitRegistrationChange();
  });
  connection.onRequest("client/unregisterCapability", (params) => {
    const registrations =
      (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? [];
    let changed = false;
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue;
      diagnosticRegistrations.delete(registration.id);
      changed = true;
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

  await connection.sendNotification("initialized", {});

  const settings = input.server.settings ?? input.server.initialization;
  if (settings) {
    await connection.sendNotification("workspace/didChangeConfiguration", { settings });
  }

  const files: Record<string, { version: number; text: string }> = {};

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

  /** 是否支持文档级 pull 诊断：静态 diagnosticProvider 或动态注册的 document 诊断。 */
  function supportsPullDiagnostics(): boolean {
    if (hasStaticPullDiagnostics) return true;
    for (const registration of diagnosticRegistrations.values()) {
      if (registration.registerOptions?.workspaceDiagnostics !== true) return true;
    }
    return false;
  }

  function documentPullState() {
    const documentRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics !== true,
    );
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap((r) => r.registerOptions?.identifier ?? [])),
      ],
      supported: supportsPullDiagnostics(),
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
    // 支持 pull 的服务器：push 已被忽略，pull 是唯一通道。正常返回但未拿到
    // 当前文档结果时重试；请求超时（服务器未响应）则中断，避免阻塞编辑。
    if (supportsPullDiagnostics()) {
      while (!connectionClosed && !request.signal?.aborted) {
        const result = await requestDocumentDiagnostics(request.path);
        if (result.matched) return;
        if (result.timedOut) return;
        await sleep(PULL_RETRY_INTERVAL_MS);
      }
      return;
    }

    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: diagnosticsDocumentWaitTimeoutMs,
    });

    while (Date.now() - startedAt < diagnosticsDocumentWaitTimeoutMs) {
      const result = await requestDocumentDiagnostics(request.path);
      if (result.matched) return;
      const remaining = diagnosticsDocumentWaitTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) return;
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) =>
          changed ? ("registration" as const) : ("timeout" as const),
        ),
      ]);
      if (next !== "registration") return;
    }
  }

  async function waitForFullDiagnostics(request: {
    path: string;
    version: number;
    after?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const startedAt = request.after ?? Date.now();
    if (supportsPullDiagnostics()) {
      while (!connectionClosed && !request.signal?.aborted) {
        const result = await requestFullDiagnostics(request.path);
        if (result.handled || result.matched) return;
        if (result.timedOut) return;
        await sleep(PULL_RETRY_INTERVAL_MS);
      }
      return;
    }

    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: diagnosticsFullWaitTimeoutMs,
    });

    while (Date.now() - startedAt < diagnosticsFullWaitTimeoutMs) {
      const result = await requestFullDiagnostics(request.path);
      if (result.handled || result.matched) return;
      const remaining = diagnosticsFullWaitTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) return;
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) =>
          changed ? ("registration" as const) : ("timeout" as const),
        ),
      ]);
      if (next !== "registration") return;
    }
  }

  // ── 公开 API ────────────────────────────────────────────────────────────────

  return {
    root: input.root,
    get serverID() {
      return input.serverID;
    },
    get connection() {
      return connection;
    },
    notify: {
      async open(request: { path: string }): Promise<number> {
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
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [{ uri, type: FILE_CHANGE_CHANGED }],
          });

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
          return next;
        }

        await connection.sendNotification("workspace/didChangeWatchedFiles", {
          changes: [{ uri, type: FILE_CHANGE_CREATED }],
        });

        pushDiagnostics.delete(resolvedPath);
        pullDiagnostics.delete(resolvedPath);
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: { uri, languageId, version: 0, text },
        });
        files[resolvedPath] = { version: 0, text };
        documentVersions.set(resolvedPath, 0);
        return 0;
      },
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
    },
    async shutdown() {
      connection.end();
      connection.dispose();
      await stopProcess(input.server.process);
    },
  };
}
