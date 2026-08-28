/**
 * LSP 管理器：所有语言服务器连接的注册表与统一入口。
 *
 * - state（client 缓存、broken 集合、spawning 去重）是 service 工厂的
 *   闭包变量，不做成模块级全局；
 * - 配置来源：全局 `~/.pi/agent/lsp.json` + 本地 `<cwd>/.pi/lsp.json`
 *   （本地覆盖全局）：`servers` 按 id 合并（同名 id 整体覆盖、新增 id，全局
 *   其余服务器保留），`enabled`/`disabled` 白名单与各超时参数继续生效；
 *   没有内置默认服务器，所有服务器均须在配置里定义；
 *   配置在每个工具的调用 cwd 下惰性读取；enabled 引用不存在的服务器 id
 *   是配置错误：全局配置在扩展加载（createLspService）时抛错，本地配置在
 *   session 开始预加载时通知，工具调用时校验抛错兜底。disabled 中未注册
 *   的 id 直接忽略；
 * - client 按 (root, serverID) 缓存，并发 spawn 去重，启动失败记入 broken
 *   集合（服务实例生命周期内不再重试）；
 * - 工具只与 touchFile / diagnostics / lspDiagnosticsForFile 三个方法打交道；通知回调按请求传入。
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { type LspServerAdapter } from "./adapter.js";
import { create, type CreateInput, type Diagnostic, type Info as LspClient } from "./client.js";
import { report } from "./diagnostic.js";
import { createAdapters, mergeServerRecords, serverConfigSchema } from "./server-config.js";

/** 超时值：number（毫秒，>=1）或字符串（"500"、"5s"、"1m"），Parse 后由 toMs 统一换算。 */
const timeoutValue = Type.Union([Type.Number({ minimum: 1 }), Type.String()]);

/** lsp.json 的配置项（全局与本地同构）。 */
const lspConfigSchema = Type.Object({
  /** 配置文件版本（当前 1）；未知版本会被 typebox 严格校验拒绝并回退空配置。 */
  version: Type.Optional(Type.Number()),
  /** 配置驱动的语言服务器定义（id → 配置）；无内置默认，全部在此定义。 */
  servers: Type.Optional(Type.Record(Type.String(), serverConfigSchema)),
  /** 只启用列出的服务器 id（缺省 = 全部启用）。 */
  enabled: Type.Optional(Type.Array(Type.String())),
  /** 从启用集中排除的服务器 id（缺省 = 无）。 */
  disabled: Type.Optional(Type.Array(Type.String())),
  /** push 诊断去抖（ms，缺省 150）。 */
  diagnosticsDebounceMs: Type.Optional(timeoutValue),
  /** document 模式诊断等待上限（ms，缺省 5_000）。 */
  diagnosticsDocumentWaitTimeoutMs: Type.Optional(timeoutValue),
  /** full 模式诊断等待上限（ms，缺省 10_000）。 */
  diagnosticsFullWaitTimeoutMs: Type.Optional(timeoutValue),
  /** 单次 pull 诊断请求超时（ms，缺省 3_000）。 */
  diagnosticsRequestTimeoutMs: Type.Optional(timeoutValue),
  /** 服务器 initialize 握手超时（ms，缺省 45_000）。 */
  initializeTimeoutMs: Type.Optional(timeoutValue),
});

/** 配置值；超时字段为原始写法（number 或字符串），换算发生在 timeoutOptions。 */
export type LspConfig = Static<typeof lspConfigSchema>;

/** "500" → 500、"5s" → 5000、"1m" → 60000；无效字符串返回 NaN（由 toMs 过滤）。 */
function parseTimeoutString(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return NaN;
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factors: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return amount * (factors[unit] ?? 1);
}

function toMs(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === "number" ? value : parseTimeoutString(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** 从配置里取超时字段（缺省 undefined，create 用自身默认值）。 */
function timeoutOptions(
  config: LspConfig,
): Pick<
  CreateInput,
  | "diagnosticsDebounceMs"
  | "diagnosticsDocumentWaitTimeoutMs"
  | "diagnosticsFullWaitTimeoutMs"
  | "diagnosticsRequestTimeoutMs"
  | "initializeTimeoutMs"
> {
  return {
    diagnosticsDebounceMs: toMs(config.diagnosticsDebounceMs),
    diagnosticsDocumentWaitTimeoutMs: toMs(config.diagnosticsDocumentWaitTimeoutMs),
    diagnosticsFullWaitTimeoutMs: toMs(config.diagnosticsFullWaitTimeoutMs),
    diagnosticsRequestTimeoutMs: toMs(config.diagnosticsRequestTimeoutMs),
    initializeTimeoutMs: toMs(config.initializeTimeoutMs),
  };
}

/** 读取并解析单个配置文件；文件不存在或解析失败时返回空配置。 */
async function readConfigFile(filePath: string): Promise<LspConfig> {
  try {
    const raw = await readFile(filePath, "utf8");
    return Value.Parse(lspConfigSchema, JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** 同步版 readConfigFile（扩展加载时校验全局配置用）。 */
function readConfigFileSync(filePath: string): LspConfig {
  try {
    const raw = readFileSync(filePath, "utf8");
    return Value.Parse(lspConfigSchema, JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/**
 * enabled 引用的 id 必须存在于实际生效的服务器集合（注入的 adapters 或配置
 * servers），否则抛配置错误（避免白名单静默失效）。disabled 中未注册的 id
 * 直接忽略。
 */
function validateConfig(config: LspConfig, adapters?: LspServerAdapter[]): void {
  const available = new Set(
    adapters ? adapters.map((adapter) => adapter.id) : Object.keys(config.servers ?? {}),
  );
  const unknown = (config.enabled ?? []).filter((id) => !available.has(id));
  if (unknown.length > 0) {
    const list = [...available].toSorted().join(", ") || "none";
    throw new Error(
      `lsp.json: unknown server id in enabled: ${unknown.join(", ")} (available: ${list})`,
    );
  }
}

/**
 * 合并后的生效配置：全局 `~/.pi/agent/lsp.json` 为基底，本地
 * `<cwd>/.pi/lsp.json` 覆盖——顶层标量字段（enabled/disabled、超时等）本地
 * 直接替换；`servers` 按 id 合并（同名 id 整体覆盖、新增 id，全局其余服务器
 * 保留）。
 */
export async function loadLspConfig(
  cwd: string,
  globalConfigPath: string = join(homedir(), ".pi", "agent", "lsp.json"),
): Promise<LspConfig> {
  const [globalConfig, localConfig] = await Promise.all([
    readConfigFile(globalConfigPath),
    readConfigFile(join(cwd, ".pi", "lsp.json")),
  ]);
  const servers = mergeServerRecords(globalConfig.servers, localConfig.servers);
  return {
    ...globalConfig,
    ...localConfig,
    ...(servers && { servers }),
  };
}

/**
 * 按配置过滤 adapter 列表。enabled 引用了实际生效集合中不存在的服务器 id
 * 时抛错（配置错误，避免白名单静默失效）；disabled 中未注册的 id 忽略。
 */
export function filterAdapters(
  adapters: LspServerAdapter[],
  config: LspConfig,
): LspServerAdapter[] {
  validateConfig(config, adapters);
  return adapters.filter((adapter) => {
    if (config.enabled && !config.enabled.includes(adapter.id)) return false;
    if (config.disabled?.includes(adapter.id)) return false;
    return true;
  });
}

interface LspState {
  clients: LspClient[];
  broken: Set<string>;
  spawning: Map<string, Promise<LspClient | undefined>>;
  closing: boolean;
  /** /lsp-stop 置 true：所有工具调用不再 spawn 服务器，直到 start/reload。 */
  disabled: boolean;
  /** root+serverID → 服务器状态，用于 footer status 显示。 */
  servers: Map<string, { serverID: string; root: string; state: "running" | "broken" }>;
}

/** 渲染 LSP status 文本的回调（传入 undefined 表示清除）。 */
export type StatusRenderer = (text: string | undefined) => void;

export interface LspRequestOptions {
  notify?: ExtensionUIContext["notify"];
  /** 中止时提前结束诊断等待（已中止时直接跳过诊断）。 */
  signal?: AbortSignal;
}

/** 让 promise 在 signal 中止时提前结算；用于中断 LSP 诊断等待。 */
async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    await promise;
    return;
  }
  const abort = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.race([promise, abort]);
}

export interface LspService {
  touchFile(
    file: string,
    cwd: string,
    diagnostics?: "document" | "full",
    options?: LspRequestOptions,
  ): Promise<void>;
  diagnostics(): Promise<Record<string, Diagnostic[]>>;
  lspDiagnosticsForFile(
    file: string,
    cwd: string,
    options?: LspRequestOptions,
  ): Promise<{ text: string; errorCount: number; warningCount: number }>;
  shutdownAll(): Promise<void>;
  /** 停止全部服务器并禁用 LSP：之后工具调用不再 spawn，直到 start/reload。 */
  stop(): Promise<void>;
  /** 解除禁用并清空 broken 缓存；服务器在下次工具调用时惰性启动。 */
  start(): void;
  /**
   * 重启指定服务器：关闭其全部 client、清除对应 broken 记录并解除禁用；
   * 其余服务器不受影响。配置在下次工具调用时重新读取。
   */
  reload(serverID: string): Promise<void>;
  /** 已知服务器 id（running 或 broken 的去重集合），供命令补全与提示。 */
  serverIDs(): string[];
  /** 注入 status 渲染回调；传入 undefined 表示不再渲染。 */
  attachStatus(render: StatusRenderer | undefined): void;
  /** 用当前服务器状态主动刷新一次 status（agent start/end 等生命周期边界）。 */
  refreshStatus(): void;
}

/** 文件必须在工作目录内才启用 LSP（对齐 opencode 的 containsPath）。 */
function containsPath(file: string, cwd: string): boolean {
  const dir = normalize(cwd);
  const target = normalize(file);
  return target === dir || target.startsWith(dir + sep);
}

/**
 * 创建 LSP 服务实例。state 由闭包持有；adapters 可注入（测试传 [] 或
 * mock adapters 即可隔离真实服务器），不注入时按配置文件 servers 与
 * 内置默认服务器合并构建。globalConfigPath 供测试注入固定的全局配置
 * 路径，避免被本机 ~/.pi/agent/lsp.json 影响。
 */
export function createLspService(
  adapters?: LspServerAdapter[],
  globalConfigPath?: string,
): LspService {
  // 扩展加载时校验全局配置（本地配置在 session_start 预加载时校验）
  validateConfig(
    readConfigFileSync(globalConfigPath ?? join(homedir(), ".pi", "agent", "lsp.json")),
    adapters,
  );
  const state: LspState = {
    clients: [],
    broken: new Set(),
    spawning: new Map(),
    closing: false,
    disabled: false,
    servers: new Map(),
  };

  let renderStatus: StatusRenderer | undefined;

  /** 汇总当前所有 LSP server 状态并渲染到 footer status。 */
  function updateStatusText(): void {
    if (!renderStatus) return;
    if (state.disabled) {
      renderStatus("lsp: disabled");
      return;
    }
    if (state.servers.size === 0) {
      renderStatus(undefined);
      return;
    }
    const parts = Array.from(state.servers.values(), (server) => {
      return `${server.serverID}${server.state === "broken" ? " (unavailable)" : ""}`;
    });
    renderStatus(`lsp: ${parts.toSorted().join(",")}`);
  }

  function attachStatus(render: StatusRenderer | undefined): void {
    renderStatus = render;
    updateStatusText();
  }

  async function getClients(
    file: string,
    cwd: string,
    notify?: ExtensionUIContext["notify"],
  ): Promise<LspClient[]> {
    if (state.closing || state.disabled) return [];
    if (!containsPath(file, cwd)) return [];
    const config = await loadLspConfig(cwd, globalConfigPath);
    const timeout = timeoutOptions(config);
    const active = filterAdapters(adapters ?? createAdapters(config.servers), config);
    const extension = extname(file) || file;
    const result: LspClient[] = [];

    for (const adapter of active) {
      if (adapter.extensions.length > 0 && !adapter.extensions.includes(extension)) continue;
      const root = await adapter.findRoot(file, cwd);
      if (!root) continue;
      const key = root + adapter.id;
      if (state.broken.has(key)) continue;

      const existing = state.clients.find((c) => c.root === root && c.serverID === adapter.id);
      if (existing) {
        result.push(existing);
        continue;
      }

      const inflight = state.spawning.get(key);
      if (inflight) {
        const client = await inflight;
        if (client) result.push(client);
        continue;
      }

      const task = (async () => {
        try {
          const handle = await adapter.spawn(root, cwd);
          if (!handle) {
            state.broken.add(key);
            state.servers.set(key, { serverID: adapter.id, root, state: "broken" });
            updateStatusText();
            notify?.(
              `LSP server "${adapter.id}" is not available for ${root} (binary not found)`,
              "error",
            );
            return;
          }
          const client = await create({
            serverID: adapter.id,
            server: handle,
            root,
            directory: cwd,
            ...timeout,
            initializeTimeoutMs: adapter.startupTimeoutMs ?? timeout.initializeTimeoutMs,
            diagnosticsDocumentWaitTimeoutMs:
              adapter.diagnosticsWaitMs ?? timeout.diagnosticsDocumentWaitTimeoutMs,
          });
          if (state.closing || state.disabled) {
            await client.shutdown();
            return;
          }
          const duplicate = state.clients.find((c) => c.root === root && c.serverID === adapter.id);
          if (duplicate) {
            await client.shutdown();
            return duplicate;
          }
          state.clients.push(client);
          state.servers.set(key, { serverID: adapter.id, root, state: "running" });
          updateStatusText();
          return client;
        } catch (error) {
          state.broken.add(key);
          state.servers.set(key, { serverID: adapter.id, root, state: "broken" });
          updateStatusText();
          notify?.(
            `LSP server "${adapter.id}" failed to start for ${root}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "error",
          );
          return;
        }
      })();
      state.spawning.set(key, task);
      void task.finally(() => {
        if (state.spawning.get(key) === task) state.spawning.delete(key);
      });

      const client = await task;
      if (client) result.push(client);
    }

    return result;
  }

  /**
   * 打开文档让服务器索引 / 产出诊断。diagnostics 传 "document" 时最多等 5s，
   * "full" 最多等 10s；不传则只通知不等待（read 的 warm-up 用）。
   */
  async function touchFile(
    file: string,
    cwd: string,
    diagnostics?: "document" | "full",
    options?: LspRequestOptions,
  ): Promise<void> {
    const clients = await getClients(file, cwd, options?.notify);
    await Promise.all(
      clients.map(async (client) => {
        const after = Date.now();
        const version = await client.notify.open({ path: file });
        if (!diagnostics) return;
        await abortable(
          client.waitForDiagnostics({
            path: file,
            version,
            mode: diagnostics,
            after,
            signal: options?.signal,
          }),
          options?.signal,
        );
      }),
    ).catch(() => {
      // 诊断等待失败不影响写操作本身
    });
  }

  /** 聚合所有 client 的当前诊断（path → diagnostics）。 */
  function diagnostics(): Promise<Record<string, Diagnostic[]>> {
    const results: Record<string, Diagnostic[]> = {};
    for (const client of state.clients) {
      for (const [filePath, diags] of client.diagnostics) {
        (results[filePath] ??= []).push(...diags);
      }
    }
    return Promise.resolve(results);
  }

  /**
   * edit/write 用：等待文档诊断并返回该文件的 ERROR / WARN 报告（text 空串表示无此类诊断）
   * 与数量。内部所有 LSP 失败都会被吞掉，不干扰写操作本身。
   */
  async function lspDiagnosticsForFile(
    file: string,
    cwd: string,
    options?: LspRequestOptions,
  ): Promise<{ text: string; errorCount: number; warningCount: number }> {
    if (options?.signal?.aborted) return { text: "", errorCount: 0, warningCount: 0 };
    await touchFile(file, cwd, "document", options);
    const all = await diagnostics();
    const normalized = normalize(file);
    const issues = all[normalized] ?? [];
    const errorCount = issues.filter((item) => (item.severity ?? 1) === 1).length;
    const warningCount = issues.filter((item) => item.severity === 2).length;
    return { text: report(normalized, issues), errorCount, warningCount };
  }

  /** 关闭全部 client 并清空缓存；closing 置 true 让 in-flight spawn 自行退出。 */
  async function closeAll(): Promise<void> {
    state.closing = true;
    await Promise.all(state.clients.map((client) => client.shutdown())).catch(() => {
      // 个别进程退出失败不阻止清理流程
    });
    state.clients = [];
    state.broken.clear();
    state.servers.clear();
    updateStatusText();
  }

  /** 终止全部服务器进程（session_shutdown 时调用，终态）。 */
  async function shutdownAll(): Promise<void> {
    await closeAll();
  }

  async function stop(): Promise<void> {
    await closeAll();
    state.closing = false;
    state.disabled = true;
    updateStatusText();
  }

  function start(): void {
    state.closing = false;
    state.disabled = false;
    state.broken.clear();
    updateStatusText();
  }

  async function reload(serverID: string): Promise<void> {
    state.closing = true;
    const targets = state.clients.filter((client) => client.serverID === serverID);
    await Promise.all(targets.map((client) => client.shutdown())).catch(() => {
      // 个别进程退出失败不阻止清理流程
    });
    state.clients = state.clients.filter((client) => client.serverID !== serverID);
    for (const [key, server] of state.servers) {
      if (server.serverID !== serverID) continue;
      state.broken.delete(key);
      state.servers.delete(key);
    }
    state.closing = false;
    state.disabled = false;
    updateStatusText();
  }

  function serverIDs(): string[] {
    return [...new Set([...state.servers.values()].map((server) => server.serverID))];
  }

  return {
    touchFile,
    diagnostics,
    lspDiagnosticsForFile,
    shutdownAll,
    stop,
    start,
    reload,
    serverIDs,
    attachStatus,
    refreshStatus: updateStatusText,
  };
}

export interface LspServiceOptions {
  adapters?: LspServerAdapter[];
  globalConfigPath?: string;
}

/** 创建 LSP service 并注册 pi 的进程级清理生命周期。 */
export function registerLsp(pi: ExtensionAPI, options?: LspServiceOptions): LspService {
  const service = createLspService(options?.adapters, options?.globalConfigPath);
  pi.on?.("session_shutdown", () => service.shutdownAll());
  // session 开始是最早能拿到本地配置 cwd 的时机：预加载并校验，配置错误立即通知
  pi.on?.("session_start", (_event, ctx) => {
    void loadLspConfig(ctx.cwd, options?.globalConfigPath)
      .then((config) => validateConfig(config, options?.adapters))
      .catch((error: unknown) => {
        if (error instanceof Error) ctx.ui.notify?.(error.message, "error");
      });
    // footer status 显示当前所有 LSP server 状态（无 UI 时不显示）
    service.attachStatus(
      ctx.ui?.setStatus
        ? (text) => ctx.ui.setStatus("lsp", text ? ctx.ui.theme.fg("accent", text) : undefined)
        : undefined,
    );
  });
  // agent 生命周期边界显式刷新 status：agent 运行中 LSP server 才被惰性
  // spawn（首次工具调用），start/end 时保证 footer 反映当前实际状态。
  pi.on?.("agent_start", () => service.refreshStatus());
  pi.on?.("agent_end", () => service.refreshStatus());

  pi.registerCommand?.("lsp-stop", {
    description: "Stop all LSP servers and disable LSP until /lsp-start or /lsp-reload",
    handler: async (_args, ctx) => {
      await service.stop();
      ctx.ui.notify?.("LSP disabled: all servers stopped", "info");
    },
  });

  pi.registerCommand?.("lsp-start", {
    description: "Re-enable LSP; servers start on the next tool call",
    handler: (_args, ctx) => {
      service.start();
      ctx.ui.notify?.("LSP enabled: servers will start on the next tool call", "info");
      return Promise.resolve();
    },
  });

  pi.registerCommand?.("lsp-reload", {
    description: "Restart a specific LSP server: /lsp-reload <server-id>",
    getArgumentCompletions: (prefix) =>
      service
        .serverIDs()
        .toSorted()
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ value: id, label: id })),
    handler: async (args, ctx) => {
      const serverID = args.trim();
      const known = service.serverIDs().toSorted();
      if (!serverID) {
        ctx.ui.notify?.(
          `usage: /lsp-reload <server-id>${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}`,
          "warning",
        );
        return;
      }
      await service.reload(serverID);
      ctx.ui.notify?.(
        `LSP server "${serverID}" reloaded: will restart on the next tool call`,
        "info",
      );
    },
  });

  return service;
}
