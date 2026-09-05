/**
 * LSP 管理器：所有语言服务器连接的注册表与统一入口。
 *
 * - state（client 缓存、broken 集合、spawning 去重）是 service 工厂的
 *   闭包变量，不做成模块级全局；
 * - 配置来源：全局 `~/.pi/agent/lsp.json` + 本地 `<cwd>/.pi/lsp.json`
 *   （本地覆盖全局）：`servers` 按 id 合并（同名 id 整体覆盖、新增 id，全局
 *   其余服务器保留），`watch` 按字段合并（本地逐字段覆盖、`ignore` 取并集）；
 *   合并结果解析为 `ResolvedLspConfig`（缺省值应用、超时换算为 ms、白名单转
 *   Set），消费方不接触"未配置"歧义；
 *   没有内置默认服务器，所有服务器均须在配置里定义；
 *   配置在 session_start 预读并按 cwd 缓存，cwd 变化或 /lsp-reload 时重读；
 *   schema 外的未知字段以 warning 上报。enabled 引用不存在的服务器 id
 *   是配置错误：全局配置在扩展加载（createLspService）时抛错，本地配置在
 *   session 开始预加载时通知，工具调用时校验抛错兜底。disabled 中未注册
 *   的 id 直接忽略；
 * - client 按 (root, serverID) 缓存，并发 spawn 去重，启动失败记入
 *   broken（冷却期内跳过，冷却过后下次触碰自动重试）并主动 notify；
 * - 工具只与 touchFile / notifyFile / diagnostics / lspDiagnosticsForFile 四个方法打交道；通知回调按请求传入。
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize, relative, sep } from "node:path";

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { Hover, WorkspaceEdit } from "vscode-languageserver-types";

import { type LspServerAdapter, serverRoot } from "./adapter.js";
import {
  clientDefaults,
  create,
  type Diagnostic,
  type Info as LspClient,
  type InspectLocation,
  LspMethodNotSupportedError,
  RenameNotPossibleError,
  WATCH_KIND_CHANGE,
  WATCH_KIND_CREATE,
  WATCH_KIND_DELETE,
} from "./client.js";
import { report } from "./diagnostic.js";
import {
  createAdapters,
  matchesInclude,
  mergeServerRecords,
  type ServerConfig,
  serverConfigSchema,
} from "./server-config.js";
import { type FileChange, watchWorkspace, type WorkspaceWatcher } from "./watcher.js";

/** 超时值：number（毫秒，>=1）或字符串（"500"、"5s"、"1m"），换算发生在 resolveConfig。 */
const timeoutValue = Type.Union([Type.Number({ minimum: 1 }), Type.String()]);

/** lsp.json 顶层 `watch` 段：工作区文件监听配置。 */
const watchConfigSchema = Type.Object({
  /** 是否启用工作区文件监听。 */
  enabled: Type.Optional(Type.Boolean()),
  /** 事件去抖时长（ms，沿用 timeoutValue 字符串写法）。 */
  debounceMs: Type.Optional(timeoutValue),
  /** 单批事件上限，超出截断并提示一次。 */
  maxBatch: Type.Optional(Type.Number({ minimum: 1 })),
  /** 追加忽略 glob（相对工作区根的 POSIX 路径）。 */
  ignore: Type.Optional(Type.Array(Type.String())),
});

/** lsp.json 的配置项（全局与本地同构；只描述用户可写的原始形态，缺省见 configDefaults）。 */
const lspConfigSchema = Type.Object({
  /** 配置文件版本（当前 1）；未知版本会被 typebox 严格校验拒绝。 */
  version: Type.Optional(Type.Number()),
  /** 配置驱动的语言服务器定义（id → 配置）；无内置默认，全部在此定义。 */
  servers: Type.Optional(Type.Record(Type.String(), serverConfigSchema)),
  /** 只启用列出的服务器 id（缺省 = 全部启用）。 */
  enabled: Type.Optional(Type.Array(Type.String())),
  /** 从启用集中排除的服务器 id（缺省 = 无）。 */
  disabled: Type.Optional(Type.Array(Type.String())),
  /** 工作区文件监听配置（缺省全部字段见 configDefaults.watch）。 */
  watch: Type.Optional(watchConfigSchema),
  /** 驻留文档上限（LRU 容量），超过时淘汰最久未使用并 didClose。 */
  maxOpenDocuments: Type.Optional(Type.Number({ minimum: 1 })),
  /** push 诊断去抖（ms）。 */
  diagnosticsDebounceMs: Type.Optional(timeoutValue),
  /** document 模式诊断等待上限（ms）。 */
  diagnosticsDocumentWaitTimeoutMs: Type.Optional(timeoutValue),
  /** full 模式诊断等待上限（ms）。 */
  diagnosticsFullWaitTimeoutMs: Type.Optional(timeoutValue),
  /** 单次 pull 诊断请求超时（ms）。 */
  diagnosticsRequestTimeoutMs: Type.Optional(timeoutValue),
  /** 服务器 initialize 握手超时（ms）。 */
  initializeTimeoutMs: Type.Optional(timeoutValue),
});

/** 配置值（单文件解析结果）；超时字段为原始写法（number 或字符串），换算在 resolveConfig。 */
export type LspConfig = Static<typeof lspConfigSchema>;

/**
 * 解析期缺省（单一来源）。超时/LRU 与 client.create 共用 clientDefaults；
 * watch 无 client 对应项，数值在此集中。
 */
export const configDefaults = {
  watch: {
    enabled: true,
    debounceMs: 300,
    flushMs: 1_000,
    maxBatch: 500,
  },
  maxOpenDocuments: clientDefaults.maxOpenDocuments,
} as const;

/** 服务器启动失败后自动重试的冷却（ms）；冷却内跳过，之后下次触碰自动重试。 */
const RETRY_COOLDOWN_MS = 60_000;
/** 同一服务器启动失败错误通知的最小间隔（ms），冷却重试反复失败时不刷屏。 */
const NOTIFY_INTERVAL_MS = 5 * 60_000;

/** 生效的工作区监听配置（缺省值已应用）。 */
export interface EffectiveWatchConfig {
  enabled: boolean;
  debounceMs: number;
  flushMs: number;
  maxBatch: number;
  ignore: string[];
}

/** 全局 + 本地合并并解析后的生效配置：所有字段为确定值，无"未配置"歧义。 */
export interface ResolvedLspConfig {
  /** 合并后的服务器定义（未配置任何服务器时为空表）。 */
  servers: Record<string, ServerConfig>;
  /** enabled 白名单（undefined = 全部启用）。 */
  enabled: Set<string> | undefined;
  /** 从启用集中排除的服务器 id（undefined = 无排除）。 */
  disabled: Set<string> | undefined;
  /** 工作区监听配置（缺省值已应用）。 */
  watch: EffectiveWatchConfig;
  /** 驻留文档 LRU 容量。 */
  maxOpenDocuments: number;
  /** 以下超时均为换算后的毫秒数（缺省见 configDefaults / clientDefaults）。 */
  diagnosticsDebounceMs: number;
  diagnosticsDocumentWaitTimeoutMs: number;
  diagnosticsFullWaitTimeoutMs: number;
  diagnosticsRequestTimeoutMs: number;
  initializeTimeoutMs: number;
}

/** "500" → 500、"5s" → 5000、"1m" → 60000；无效字符串返回 NaN（由调用方兜底缺省）。 */
function parseTimeoutString(value: string): number {
  // 单位组永远参与匹配（缺省为空串），避免"可选捕获组在类型上不可空"的歧义
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|)\s*$/.exec(value.trim());
  if (!match) return NaN;
  const amount = Number(match[1]);
  const factors: Record<string, number | undefined> = {
    "": 1,
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  const factor = factors[match[2]];
  return amount * (factor ?? 1);
}

/** 时长字段换算为 ms：number 原样、字符串按 parseTimeoutString；无效值返回 undefined。 */
function toMs(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === "number" ? value : parseTimeoutString(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** 把合并后的原始配置解析为生效配置：应用 configDefaults 缺省、字符串时长换算、白名单转 Set。 */
export function resolveConfig(raw: LspConfig): ResolvedLspConfig {
  return {
    servers: raw.servers ?? {},
    enabled: raw.enabled === undefined ? undefined : new Set(raw.enabled),
    disabled: raw.disabled === undefined ? undefined : new Set(raw.disabled),
    watch: {
      enabled: raw.watch?.enabled ?? configDefaults.watch.enabled,
      debounceMs: toMs(raw.watch?.debounceMs) ?? configDefaults.watch.debounceMs,
      flushMs: configDefaults.watch.flushMs,
      maxBatch: raw.watch?.maxBatch ?? configDefaults.watch.maxBatch,
      ignore: raw.watch?.ignore ?? [],
    },
    maxOpenDocuments: raw.maxOpenDocuments ?? configDefaults.maxOpenDocuments,
    diagnosticsDebounceMs: toMs(raw.diagnosticsDebounceMs) ?? clientDefaults.diagnosticsDebounceMs,
    diagnosticsDocumentWaitTimeoutMs:
      toMs(raw.diagnosticsDocumentWaitTimeoutMs) ?? clientDefaults.diagnosticsDocumentWaitTimeoutMs,
    diagnosticsFullWaitTimeoutMs:
      toMs(raw.diagnosticsFullWaitTimeoutMs) ?? clientDefaults.diagnosticsFullWaitTimeoutMs,
    diagnosticsRequestTimeoutMs:
      toMs(raw.diagnosticsRequestTimeoutMs) ?? clientDefaults.diagnosticsRequestTimeoutMs,
    initializeTimeoutMs: toMs(raw.initializeTimeoutMs) ?? clientDefaults.initializeTimeoutMs,
  };
}

/** 文件不存在的读取错误（ENOENT），其余错误原样抛出。 */
function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ENOENT";
}

/**
 * 收集 schema 之外的未知字段警告（typebox 不校验 additionalProperties，
 * 未知键会静默存活在解析结果里，这里显式报告避免配置写错无感知）。
 */
function unknownFieldWarnings(config: LspConfig, filePath: string): string[] {
  const warnings: string[] = [];
  const check = (record: object, known: Record<string, unknown>, scope: string): void => {
    for (const key of Object.keys(record)) {
      if (!(key in known)) warnings.push(`${filePath}${scope}: unknown field "${key}" ignored`);
    }
  };
  check(config, lspConfigSchema.properties, "");
  if (config.watch) check(config.watch, watchConfigSchema.properties, " watch");
  for (const [id, server] of Object.entries(config.servers ?? {})) {
    check(server, serverConfigSchema.properties, ` (server "${id}")`);
  }
  return warnings;
}

/** 读取并解析单个配置文件；文件不存在视为空配置，JSON / typebox 校验错误直接抛出。 */
async function readConfigFile(
  filePath: string,
  onWarning?: (message: string) => void,
): Promise<LspConfig> {
  try {
    const raw = await readFile(filePath, "utf8");
    const config = Value.Parse(lspConfigSchema, JSON.parse(raw) as unknown);
    for (const message of unknownFieldWarnings(config, filePath)) onWarning?.(message);
    return config;
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

/** 同步版 readConfigFile（扩展加载时校验全局配置用）。 */
function readConfigFileSync(filePath: string, onWarning?: (message: string) => void): LspConfig {
  try {
    const raw = readFileSync(filePath, "utf8");
    const config = Value.Parse(lspConfigSchema, JSON.parse(raw) as unknown);
    for (const message of unknownFieldWarnings(config, filePath)) onWarning?.(message);
    return config;
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

/**
 * enabled 引用的 id 必须存在于实际生效的服务器集合（注入的 adapters 或配置
 * servers），否则抛配置错误（避免白名单静默失效）。disabled 中未注册的 id
 * 直接忽略。
 */
function validateConfig(config: ResolvedLspConfig, adapters?: LspServerAdapter[]): void {
  const available = new Set(
    adapters ? adapters.map((adapter) => adapter.id) : Object.keys(config.servers),
  );
  const unknown = config.enabled === undefined ? [] : [...config.enabled.difference(available)];
  if (unknown.length > 0) {
    const list = [...available].toSorted().join(", ") || "none";
    throw new Error(
      `lsp.json: unknown server id in enabled: ${unknown.join(", ")} (available: ${list})`,
    );
  }
}

/** 合并 watch 段：全局为基底、本地逐字段覆盖；ignore 取并集去重（全局在前）。两边都未配置时返回 undefined，调用方据此省略 watch 键。 */
function mergeWatch(
  globalWatch: LspConfig["watch"],
  localWatch: LspConfig["watch"],
): LspConfig["watch"] {
  if (!globalWatch && !localWatch) return undefined;
  return {
    ...globalWatch,
    ...localWatch,
    ignore: [...new Set([...(globalWatch?.ignore ?? []), ...(localWatch?.ignore ?? [])])],
  };
}

/**
 * 合并全局与本地两份原始配置（纯函数，供 loadLspConfig 与针对性测试使用）：
 * 全局为基底、本地逐字段覆盖；`servers` 按 id 合并（同名 id 整体覆盖、新增 id，
 * 全局其余服务器保留）；`watch` 按字段合并（本地逐字段覆盖、缺省用全局，
 * `ignore` 取并集去重）。
 */
export function mergeConfig(globalConfig: LspConfig, localConfig: LspConfig): LspConfig {
  const servers = mergeServerRecords(globalConfig.servers, localConfig.servers);
  const watch = mergeWatch(globalConfig.watch, localConfig.watch);
  return {
    ...globalConfig,
    ...localConfig,
    ...(servers && { servers }),
    ...(watch && { watch }),
  };
}

/** 读取全局 + 本地配置，合并并解析为生效配置；未知字段警告经 onWarning 上报。 */
export async function loadLspConfig(
  cwd: string,
  globalConfigPath: string = join(homedir(), ".pi", "agent", "lsp.json"),
  onWarning?: (message: string) => void,
): Promise<ResolvedLspConfig> {
  const [globalConfig, localConfig] = await Promise.all([
    readConfigFile(globalConfigPath, onWarning),
    readConfigFile(join(cwd, ".pi", "lsp.json"), onWarning),
  ]);
  return resolveConfig(mergeConfig(globalConfig, localConfig));
}

/**
 * 按配置过滤 adapter 列表。enabled 引用了实际生效集合中不存在的服务器 id
 * 时抛错（配置错误，避免白名单静默失效）；disabled 中未注册的 id 忽略。
 */
export function filterAdapters(
  adapters: LspServerAdapter[],
  config: ResolvedLspConfig,
): LspServerAdapter[] {
  validateConfig(config, adapters);
  return adapters.filter((adapter) => {
    if (config.enabled && !config.enabled.has(adapter.id)) return false;
    if (config.disabled?.has(adapter.id)) return false;
    return true;
  });
}

interface LspState {
  clients: LspClient[];
  /** root+serverID → 最近一次启动失败时间；冷却期过后允许自动重试。 */
  brokenFailAt: Map<string, number>;
  /** root+serverID → 最近一次启动失败错误通知时间；节流避免反复刷屏。 */
  brokenNotifiedAt: Map<string, number>;
  spawning: Map<string, Promise<LspClient | undefined>>;
  closing: boolean;
  /** /lsp-stop 置 true：所有工具调用不再 spawn 服务器，直到 start/reload。 */
  disabled: boolean;
  /** root+serverID → 服务器状态，用于 footer status 显示。 */
  servers: Map<string, { serverID: string; root: string; state: "running" | "broken" }>;
  /** 当前会话工作目录（watcher 挂载点）；变化时重建监听器。 */
  cwd: string | undefined;
  /** client → adapter 扩展名集合，fan-out 时按扩展名过滤。 */
  clientExtensions: Map<LspClient, readonly string[]>;
  /** 缓存的生效配置（configCwd 一致时复用；cwd 变化或 reload 后重读）。 */
  config: ResolvedLspConfig | undefined;
  /** config 的加载 cwd。 */
  configCwd: string | undefined;
}

/** 渲染 LSP status 文本的回调（传入 undefined 表示清除）。 */
export type StatusRenderer = (text: string | undefined) => void;

export type LspInspectQuery = "definition" | "references" | "hover";

/**
 * 返回类型与 query 泛型关联：query 为 "hover" 时返回 hover 内容，否则返回
 * 位置列表。实现内部用 cast 建立关联（TS 无法验证分支与泛型的对应关系）。
 */
export type LspInspectResult<Q extends LspInspectQuery = LspInspectQuery> = Q extends "hover"
  ? { serverID: string; query: "hover"; hover: Hover | null }
  : { serverID: string; query: "definition" | "references"; locations: InspectLocation[] };

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
  /** read 用：只发文件事件通知服务器磁盘上有该文件，不驻留、不等诊断。 */
  notifyFile(file: string, cwd: string, options?: LspRequestOptions): Promise<void>;
  diagnostics(): Promise<Record<string, Diagnostic[]>>;
  lspDiagnosticsForFile(
    file: string,
    cwd: string,
    options?: LspRequestOptions,
  ): Promise<{ text: string; errorCount: number; warningCount: number }>;
  /**
   * 符号重命名：只面向 kind 为 "language" 的服务器（linter 不参与符号级
   * 功能）；多 client 按配置顺序取第一个成功结果，全部失败时抛聚合错误。
   * line / character 为 0-based LSP position。
   */
  rename(request: {
    file: string;
    cwd: string;
    line: number;
    character: number;
    newName: string;
    options?: LspRequestOptions;
  }): Promise<{ serverID: string; edit: WorkspaceEdit; placeholder?: string }>;
  /**
   * 只读符号查询（definition / references / hover）：只面向 kind 为 "language"
   * 的服务器，按配置顺序取第一个成功结果；服务器不支持该方法（MethodNotFound）
   * 时跳过并尝试下一个，全部不支持时抛聚合错误。line / character 为 0-based。
   */
  inspect<Q extends LspInspectQuery>(request: {
    file: string;
    cwd: string;
    line: number;
    character: number;
    query: Q;
    options?: LspRequestOptions;
  }): Promise<LspInspectResult<Q>>;
  shutdownAll(): Promise<void>;
  /** 停止全部服务器并禁用 LSP：之后工具调用不再 spawn，直到 start/reload。 */
  stop(): Promise<void>;
  /** 解除禁用；服务器在下次工具调用时惰性启动（启动失败会按冷却自动重试）。 */
  start(): void;
  /**
   * 重启指定服务器：关闭其全部 client、清除对应失败记录并解除禁用；
   * 其余服务器不受影响。配置缓存失效并立即重读盘上配置：此前运行中的该
   * 服务器若仍存在于新配置则马上重启，未在运行的服务器保持惰性。
   * 返回成功重启的 server id。
   */
  reload(serverID: string): Promise<string[]>;
  /**
   * 重启全部服务器（/lsp-reload 无参）：关闭所有 client、清空失败记录并
   * 解除禁用；配置缓存失效并立即重读盘上配置，此前运行中的服务器若仍存在
   * 于新配置则马上重启。返回成功重启的 server id。
   */
  reloadAll(): Promise<string[]>;
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
export interface LspServiceStartupOptions {
  /**
   * 服务器启动失败后到允许自动重试的冷却时长（ms）。冷却期内该服务器被
   * 跳过，冷却过后下次触碰匹配文件时自动重试，无需 /lsp-reload。
   */
  retryCooldownMs?: number;
  /** 同一服务器的启动失败错误通知最小间隔（ms），防止反复重试刷屏。 */
  notifyIntervalMs?: number;
  /** 会话级通知：启动失败时主动上报，不依赖触发请求恰好携带 notify。 */
  notify?: ExtensionUIContext["notify"];
  /** session_start 预读的生效配置：直接注入缓存，避免首个工具调用重复读盘。 */
  initialConfig?: ResolvedLspConfig;
  /** initialConfig 对应的 cwd。 */
  initialCwd?: string;
}

export function createLspService(
  adapters?: LspServerAdapter[],
  globalConfigPath?: string,
  startupOptions?: LspServiceStartupOptions,
): LspService {
  const retryCooldownMs = startupOptions?.retryCooldownMs ?? RETRY_COOLDOWN_MS;
  const notifyIntervalMs = startupOptions?.notifyIntervalMs ?? NOTIFY_INTERVAL_MS;
  const sessionNotify = startupOptions?.notify;
  // 扩展加载时校验全局配置（本地配置在 session_start 预加载时校验）
  validateConfig(
    resolveConfig(
      readConfigFileSync(globalConfigPath ?? join(homedir(), ".pi", "agent", "lsp.json")),
    ),
    adapters,
  );
  const state: LspState = {
    clients: [],
    brokenFailAt: new Map(),
    brokenNotifiedAt: new Map(),
    spawning: new Map(),
    closing: false,
    disabled: false,
    servers: new Map(),
    cwd: undefined,
    clientExtensions: new Map(),
    config: startupOptions?.initialConfig,
    configCwd: startupOptions?.initialCwd,
  };

  let renderStatus: StatusRenderer | undefined;

  /** 配置缓存：同一 cwd 内复用；cwd 变化或 reload 清缓存后重读。 */
  async function currentConfig(cwd: string): Promise<ResolvedLspConfig> {
    if (state.config && state.configCwd === cwd) return state.config;
    const config = await loadLspConfig(cwd, globalConfigPath, (message) =>
      sessionNotify?.(message, "warning"),
    );
    state.config = config;
    state.configCwd = cwd;
    return config;
  }

  // ── 工作区文件监听（watcher）───────────────────────────────────────────────

  let watcher: WorkspaceWatcher | undefined;
  let watcherCwd: string | undefined;

  async function stopWatcher(): Promise<void> {
    const current = watcher;
    watcher = undefined;
    watcherCwd = undefined;
    if (current) {
      try {
        await current.stop();
      } catch {
        // 停止失败不影响流程
      }
    }
  }

  /** 事件按各 client 的 root 前缀 / 注册 pattern / 扩展名过滤后投递。 */
  async function fanOut(changes: FileChange[]): Promise<void> {
    const cwd = state.cwd;
    if (!cwd) return;
    await Promise.all(
      state.clients.map(async (client) => {
        const filtered = changes.filter((change) => {
          if (!containsPath(change.path, cwd) || !containsPath(change.path, client.root)) {
            return false;
          }
          const watchers = client.watchers();
          if (watchers.length > 0) {
            // pattern 可能是相对 glob（pyright 的 "**"）也可能是绝对 glob
            // （gopls 的 "/workspace/**/*.{go,mod}"），两个候选任一命中即转发；
            // 并按各 watcher 注册的 WatchKind 位过滤事件类型
            const relativeCandidate = relative(client.root, change.path).split(sep).join("/");
            const absoluteCandidate = change.path.split(sep).join("/");
            const kindBit =
              change.type === "created"
                ? WATCH_KIND_CREATE
                : change.type === "changed"
                  ? WATCH_KIND_CHANGE
                  : WATCH_KIND_DELETE;
            const matched = watchers.some(
              (watcher) =>
                (watcher.kind & kindBit) !== 0 &&
                (minimatch(relativeCandidate, watcher.pattern) ||
                  minimatch(absoluteCandidate, watcher.pattern)),
            );
            if (!matched) return false;
          }
          const extensions = state.clientExtensions.get(client);
          return (
            extensions === undefined ||
            extensions.length === 0 ||
            extensions.includes(extname(change.path))
          );
        });
        if (filtered.length === 0) return;
        try {
          await client.notify.watchedFiles(filtered);
        } catch {
          // 单个 client 通知失败不影响其余 client
        }
      }),
    );
  }

  /** 首个 client 建立 / 会话 cwd 变化时（重）建监听器；watch.enabled: false 时不启动。 */
  async function ensureWatcher(cwd: string, notify?: ExtensionUIContext["notify"]): Promise<void> {
    if (state.closing || state.disabled) return;
    const config = await currentConfig(cwd);
    const watch = config.watch;
    if (!watch.enabled) return;
    if (watcher && watcherCwd === cwd) return;
    await stopWatcher();
    try {
      watcher = await watchWorkspace(cwd, (changes) => void fanOut(changes), {
        debounceMs: watch.debounceMs,
        flushMs: watch.flushMs,
        maxBatch: watch.maxBatch,
        ignore: watch.ignore,
        onError: (message) => notify?.(message, "error"),
        onTruncated: () =>
          notify?.(
            "workspace file events truncated (batch limit exceeded); run /lsp-reload <id> if diagnostics look stale",
            "warning",
          ),
      });
      watcherCwd = cwd;
    } catch (error) {
      notify?.(
        `workspace watcher failed to start for ${cwd}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
    }
  }

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

  /**
   * 记录一次启动失败：进入 broken（冷却期内跳过）、渲染 status，并按节流
   * 间隔主动 notify。错误上报优先走会话级 sessionNotify——不依赖触发请求
   * 恰好携带 notify（否则 Read warm-up 等静默通道会把失败吞掉）；未注入
   * 会话通知时退回请求级 notify 兜底。
   */
  function reportStartupFailure(
    key: string,
    serverID: string,
    root: string,
    cause: string,
    notify?: ExtensionUIContext["notify"],
  ): void {
    const now = Date.now();
    state.brokenFailAt.set(key, now);
    state.servers.set(key, { serverID, root, state: "broken" });
    updateStatusText();
    const reporter = sessionNotify ?? notify;
    const lastNotified = state.brokenNotifiedAt.get(key);
    if (reporter && (lastNotified === undefined || now - lastNotified >= notifyIntervalMs)) {
      state.brokenNotifiedAt.set(key, now);
      reporter(
        `LSP server "${serverID}" failed to start for ${root}: ${cause}. ` +
          `Fix the issue or run /lsp-reload ${serverID} to retry now.`,
        "error",
      );
    }
  }

  /**
   * spawn 指定 adapter 并注册 client：同一 key 的 in-flight spawn 复用其结果，
   * 失败进 broken（节流上报，返回 undefined），成功后注册 client / extensions /
   * status 并确保 watcher 运行。供 getClients 与 reload 后的立即重启共用。
   */
  async function startClient(
    adapter: LspServerAdapter,
    root: string,
    cwd: string,
    config: ResolvedLspConfig,
    notify?: ExtensionUIContext["notify"],
  ): Promise<LspClient | undefined> {
    const key = root + adapter.id;
    const inflight = state.spawning.get(key);
    if (inflight) return inflight;
    const task = (async () => {
      try {
        const handle = await adapter.spawn(root, cwd);
        if (!handle) {
          reportStartupFailure(key, adapter.id, root, "binary not found", notify);
          return;
        }
        const client = await create({
          serverID: adapter.id,
          server: handle,
          root,
          directory: cwd,
          diagnosticsDebounceMs: config.diagnosticsDebounceMs,
          diagnosticsDocumentWaitTimeoutMs:
            adapter.diagnosticsWaitMs ?? config.diagnosticsDocumentWaitTimeoutMs,
          diagnosticsFullWaitTimeoutMs: config.diagnosticsFullWaitTimeoutMs,
          diagnosticsRequestTimeoutMs: config.diagnosticsRequestTimeoutMs,
          initializeTimeoutMs: adapter.startupTimeoutMs ?? config.initializeTimeoutMs,
          maxOpenDocuments: config.maxOpenDocuments,
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
        state.clientExtensions.set(client, adapter.extensions);
        state.servers.set(key, { serverID: adapter.id, root, state: "running" });
        // 启动成功：清除失败记录，之后若再次失败会立即重新上报
        state.brokenFailAt.delete(key);
        state.brokenNotifiedAt.delete(key);
        updateStatusText();
        void ensureWatcher(cwd, notify);
        return client;
      } catch (error) {
        reportStartupFailure(
          key,
          adapter.id,
          root,
          error instanceof Error ? error.message : String(error),
          notify,
        );
        return;
      }
    })();
    state.spawning.set(key, task);
    void task.finally(() => {
      if (state.spawning.get(key) === task) state.spawning.delete(key);
    });
    return task;
  }

  async function getClients(
    file: string,
    cwd: string,
    notify?: ExtensionUIContext["notify"],
    adapterFilter?: (adapter: LspServerAdapter) => boolean,
  ): Promise<LspClient[]> {
    if (state.closing || state.disabled) return [];
    if (!containsPath(file, cwd)) return [];
    const config = await currentConfig(cwd);
    const active = filterAdapters(adapters ?? createAdapters(config.servers), config);
    const extension = extname(file) || file;
    const result: LspClient[] = [];

    // 会话 cwd 变化时重建 watcher（首个 client 建立后启动）
    if (state.cwd !== cwd) {
      state.cwd = cwd;
      await stopWatcher();
    }

    for (const adapter of active) {
      if (adapterFilter && !adapterFilter(adapter)) continue;
      if (adapter.extensions.length > 0 && !adapter.extensions.includes(extension)) continue;
      const root = serverRoot(adapter.workingDir, cwd);
      if (!containsPath(file, root)) continue;
      if (!matchesInclude(adapter.include ?? [], file, root, cwd)) continue;
      const key = root + adapter.id;
      const failedAt = state.brokenFailAt.get(key);
      if (failedAt !== undefined) {
        if (Date.now() - failedAt < retryCooldownMs) continue;
        // 冷却已过：允许重试；重试成功后下面会清除 broken 记录
        state.brokenFailAt.delete(key);
      }

      const existing = state.clients.find((c) => c.root === root && c.serverID === adapter.id);
      if (existing) {
        result.push(existing);
        continue;
      }

      const client = await startClient(adapter, root, cwd, config, notify);
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
   * read 的 warm-up：通知服务器磁盘上有这个文件（D5），不 didOpen 驻留、不等诊断。
   * 驻留文档若磁盘已被外部改写会顺带触发退场。
   */
  async function notifyFile(file: string, cwd: string, options?: LspRequestOptions): Promise<void> {
    const clients = await getClients(file, cwd, options?.notify);
    await Promise.all(
      clients.map((client) =>
        client.notify.watchedFiles([{ path: file, type: "changed", isDirectory: false }]),
      ),
    ).catch(() => {
      // 文件事件通知失败不影响读取
    });
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

  /** 符号重命名：只面向 language 类服务器；按配置顺序取第一个成功结果。 */
  async function rename(request: {
    file: string;
    cwd: string;
    line: number;
    character: number;
    newName: string;
    options?: LspRequestOptions;
  }): Promise<{ serverID: string; edit: WorkspaceEdit; placeholder?: string }> {
    const clients = await getClients(
      request.file,
      request.cwd,
      request.options?.notify,
      (adapter) => adapter.kind !== "linter",
    );
    if (clients.length === 0) {
      throw new RenameNotPossibleError(
        `no LSP language server available for ${request.file} (check lsp.json servers and kind)`,
      );
    }
    const failures: { serverID: string; error: unknown }[] = [];
    for (const client of clients) {
      try {
        const result = await client.renameSymbol({
          path: request.file,
          line: request.line,
          character: request.character,
          newName: request.newName,
        });
        return {
          serverID: client.serverID,
          edit: result.edit,
          ...(result.placeholder !== undefined && { placeholder: result.placeholder }),
        };
      } catch (error) {
        failures.push({ serverID: client.serverID, error });
      }
    }
    const allNotRenameable = failures.every((f) => f.error instanceof RenameNotPossibleError);
    const detail = failures
      .map((f) => `${f.serverID}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
      .join("; ");
    throw allNotRenameable
      ? new RenameNotPossibleError(detail)
      : new Error(`LSP rename failed on all servers — ${detail}`);
  }

  /** 只读符号查询：与 rename 同款多服务器策略，但 MethodNotFound 是"跳过"而非失败。 */
  async function inspect<Q extends LspInspectQuery>(request: {
    file: string;
    cwd: string;
    line: number;
    character: number;
    query: Q;
    options?: LspRequestOptions;
  }): Promise<LspInspectResult<Q>> {
    const clients = await getClients(
      request.file,
      request.cwd,
      request.options?.notify,
      (adapter) => adapter.kind !== "linter",
    );
    if (clients.length === 0) {
      throw new Error(
        `no LSP language server available for ${request.file} (check lsp.json servers and kind)`,
      );
    }
    const failures: { serverID: string; error: unknown }[] = [];
    for (const client of clients) {
      const position = { path: request.file, line: request.line, character: request.character };
      try {
        if (request.query === "hover") {
          const hover = await client.hover(position);
          return { serverID: client.serverID, query: "hover", hover } as LspInspectResult<Q>;
        }
        const locations =
          request.query === "definition"
            ? await client.definition(position)
            : await client.references(position);
        return {
          serverID: client.serverID,
          query: request.query,
          locations,
        } as LspInspectResult<Q>;
      } catch (error) {
        failures.push({ serverID: client.serverID, error });
      }
    }
    const allNotSupported = failures.every((f) => f.error instanceof LspMethodNotSupportedError);
    const detail = failures
      .map((f) => `${f.serverID}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
      .join("; ");
    throw allNotSupported
      ? new LspMethodNotSupportedError("all configured servers", `textDocument/${request.query}`)
      : new Error(`LSP inspect failed on all servers — ${detail}`);
  }

  /** 关闭全部 client 并清空缓存；closing 置 true 让 in-flight spawn 自行退出。 */
  async function closeAll(): Promise<void> {
    state.closing = true;
    await Promise.all(state.clients.map((client) => client.shutdown())).catch(() => {
      // 个别进程退出失败不阻止清理流程
    });
    state.clients = [];
    state.clientExtensions.clear();
    state.brokenFailAt.clear();
    state.brokenNotifiedAt.clear();
    state.servers.clear();
    await stopWatcher();
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
    state.brokenFailAt.clear();
    state.brokenNotifiedAt.clear();
    updateStatusText();
  }

  /**
   * reload 后立即重启此前运行中的服务器，不再等下一次工具调用。只重启新配置
   * 中仍存在且启用的 server；无运行记录（如 /lsp-stop 之后）或配置重读失败时
   * 不动，保持惰性 spawn。返回成功重启的 server id。
   */
  async function respawnRunning(serverIDs: readonly string[]): Promise<string[]> {
    const cwd = state.cwd;
    if (!cwd) return [];
    let config: ResolvedLspConfig;
    try {
      config = await currentConfig(cwd);
    } catch (error) {
      sessionNotify?.(
        `LSP reload: re-reading config failed, servers will start on the next tool call: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
      );
      return [];
    }
    const active = filterAdapters(adapters ?? createAdapters(config.servers), config);
    const restarted = await Promise.all(
      serverIDs.map(async (serverID): Promise<string | undefined> => {
        const adapter = active.find((candidate) => candidate.id === serverID);
        if (!adapter) return;
        const root = serverRoot(adapter.workingDir, cwd);
        const client = await startClient(adapter, root, cwd, config);
        return client ? serverID : undefined;
      }),
    );
    return restarted.filter((id): id is string => id !== undefined);
  }

  async function reload(serverID: string): Promise<string[]> {
    const wasRunning = state.clients.some((client) => client.serverID === serverID);
    state.closing = true;
    // 配置缓存失效：立即重读盘上配置，让配置修改生效
    state.config = undefined;
    state.configCwd = undefined;
    const targets = state.clients.filter((client) => client.serverID === serverID);
    await Promise.all(targets.map((client) => client.shutdown())).catch(() => {
      // 个别进程退出失败不阻止清理流程
    });
    state.clients = state.clients.filter((client) => client.serverID !== serverID);
    for (const client of targets) state.clientExtensions.delete(client);
    for (const [key, server] of state.servers) {
      if (server.serverID !== serverID) continue;
      state.brokenFailAt.delete(key);
      state.brokenNotifiedAt.delete(key);
      state.servers.delete(key);
    }
    if (state.clients.length === 0) await stopWatcher();
    state.closing = false;
    state.disabled = false;
    updateStatusText();
    if (!wasRunning) return [];
    return respawnRunning([serverID]);
  }

  async function reloadAll(): Promise<string[]> {
    const runningIDs = [...new Set(state.clients.map((client) => client.serverID))];
    state.closing = true;
    state.config = undefined;
    state.configCwd = undefined;
    await Promise.all(state.clients.map((client) => client.shutdown())).catch(() => {
      // 个别进程退出失败不阻止清理流程
    });
    state.clients = [];
    state.clientExtensions.clear();
    state.brokenFailAt.clear();
    state.brokenNotifiedAt.clear();
    state.servers.clear();
    await stopWatcher();
    state.closing = false;
    state.disabled = false;
    updateStatusText();
    return respawnRunning(runningIDs);
  }

  function serverIDs(): string[] {
    return [...new Set([...state.servers.values()].map((server) => server.serverID))];
  }

  return {
    touchFile,
    notifyFile,
    diagnostics,
    lspDiagnosticsForFile,
    rename,
    inspect,
    shutdownAll,
    stop,
    start,
    reload,
    reloadAll,
    serverIDs,
    attachStatus,
    refreshStatus: updateStatusText,
  };
}

export interface LspServiceOptions {
  adapters?: LspServerAdapter[];
  globalConfigPath?: string;
}

export interface LspManagerHooks {
  /**
   * session_start 校验通过且存在 enabled 服务器时调用（每实例至多一次）；
   * LSP 专属工具（rename / inspect 族）在此注册，未配置时保持不可见。
   */
  onEnabled: (pi: ExtensionAPI, service: LspService) => void;
}

export interface LspManager {
  /**
   * 文件工具的 service 访问器：永不抛错。disabled / session_start 未运行时
   * 返回共享 no-op service（诊断与文件事件通知为空操作）。
   */
  mustLazyGetService(): LspService;
  /** 当前会话是否已创建 service（/lsp-stop 后仍为 true，内部 disabled 语义不变）。 */
  haveEnabledLsp(): boolean;
}

/**
 * no-op service 单例：空 adapter 列表 → getClients 永远返回空，任何请求都是
 * 空操作。globalConfigPath 指向必然不存在的文件——真实全局配置若声明了
 * `enabled`，createLspService 的建时校验会因空 adapter 集合而抛错。
 */
const noopServiceHolder: { service?: LspService } = {};
function getNoopService(): LspService {
  noopServiceHolder.service ??= createLspService(
    [],
    join(tmpdir(), ".pi-lsp-noop-global-does-not-exist.json"),
  );
  return noopServiceHolder.service;
}

/** 会话配置里生效（未被 enabled 白名单排除、未被 disabled）的服务器数量。 */
function enabledServerCount(config: ResolvedLspConfig, adapters?: LspServerAdapter[]): number {
  const ids = adapters ? adapters.map((adapter) => adapter.id) : Object.keys(config.servers);
  return ids.filter((id) => {
    if (config.enabled && !config.enabled.has(id)) return false;
    if (config.disabled?.has(id)) return false;
    return true;
  }).length;
}

/**
 * 创建 LSP manager 并注册 pi 会话生命周期：
 * - session_start（被 pi await）：加载并校验配置；存在 enabled 服务器才创建
 *   service（进程仍首次工具调用才 spawn）并调用 onEnabled 注册 LSP 工具；
 *   配置缺失或错误则保持 disabled（错误 notify 后降级，不阻断会话启动）。
 * - session_shutdown：关闭全部服务器进程。
 * 文件工具经 mustLazyGetService 访问，在任何状态下都能安全工作。
 */
export function createLspManager(
  pi: ExtensionAPI,
  hooks: LspManagerHooks,
  options?: LspServiceOptions,
): LspManager {
  let service: LspService | undefined;

  pi.on("session_start", async (_event, ctx) => {
    // /reload 等路径可能对同一 runner 重发 session_start：先清掉旧实例再建
    if (service !== undefined) {
      // 旧实例关闭失败不阻断新会话构建
      await service.shutdownAll().catch(() => {
        /* noop */
      });
      service = undefined;
    }
    try {
      const config = await loadLspConfig(ctx.cwd, options?.globalConfigPath, (message) => {
        try {
          ctx.ui.notify(message, "warning");
        } catch {
          /* 旧会话 ctx 已失效：通知无处可去 */
        }
      });
      validateConfig(config, options?.adapters);
      if (enabledServerCount(config, options?.adapters) === 0) return;
      // 下面两个闭包被 service 长期持有，可能在会话被替换或 reload 后仍触发
      // （session_shutdown 清理、后台 watcher 错误、in-flight spawn 失败），
      // 而旧 ctx 已被 pi 标记 stale，ctx.ui getter 会直接抛错。UI 写入是尽力
      // 而为的上报，stale 时静默跳过——抛错逃逸会变成 unhandled rejection，
      // pi 会因此整个退出。
      const next = createLspService(options?.adapters, options?.globalConfigPath, {
        // 会话级通知：任何通道触发的启动失败都主动上报（不只依赖请求方 notify）
        notify: (message, level) => {
          try {
            ctx.ui.notify(message, level);
          } catch {
            /* 旧会话 ctx 已失效或 UI 不可用：通知无处可去 */
          }
        },
        // session_start 已读盘的配置直接注入缓存，首个工具调用无需重复读盘
        initialConfig: config,
        initialCwd: ctx.cwd,
      });
      // footer status 显示当前所有 LSP server 状态（无 UI 时不显示）
      next.attachStatus((text) => {
        try {
          ctx.ui.setStatus("lsp", text ? ctx.ui.theme.fg("accent", text) : undefined);
        } catch {
          /* 旧会话 ctx 已失效：footer 不再属于本 service */
        }
      });
      service = next;
      hooks.onEnabled(pi, next);
    } catch (error) {
      service = undefined;
      if (error instanceof Error) ctx.ui.notify(error.message, "error");
    }
  });

  pi.on("session_shutdown", () => {
    // 关停阶段 UI 已不可用（可能恰逢会话替换、旧 ctx 已 stale），清理失败
    // 无处上报，静默吞掉以避免 unhandled rejection 致 pi 退出
    void service?.shutdownAll().catch(() => {
      /* noop */
    });
  });

  // agent 生命周期边界显式刷新 status：agent 运行中 LSP server 才被惰性
  // spawn（首次工具调用），start/end 时保证 footer 反映当前实际状态。
  pi.on("agent_start", () => service?.refreshStatus());
  pi.on("agent_end", () => service?.refreshStatus());

  pi.registerCommand("lsp-stop", {
    description: "Stop all LSP servers and disable LSP until /lsp-start or /lsp-reload",
    handler: async (_args, ctx) => {
      if (service === undefined) {
        ctx.ui.notify("LSP not configured: nothing to stop", "warning");
        return;
      }
      await service.stop();
      ctx.ui.notify("LSP disabled: all servers stopped", "info");
    },
  });

  pi.registerCommand("lsp-start", {
    description: "Re-enable LSP; servers start on the next tool call",
    handler: (_args, ctx) => {
      if (service === undefined) {
        ctx.ui.notify("LSP not configured: nothing to enable", "warning");
        return Promise.resolve();
      }
      service.start();
      ctx.ui.notify("LSP enabled: servers will start on the next tool call", "info");
      return Promise.resolve();
    },
  });

  pi.registerCommand("lsp-reload", {
    description:
      "Restart LSP servers: /lsp-reload <server-id> for one, no argument reloads config and restarts all",
    getArgumentCompletions: (prefix) =>
      (service?.serverIDs() ?? [])
        .toSorted()
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ value: id, label: id })),
    handler: async (args, ctx) => {
      if (service === undefined) {
        ctx.ui.notify("LSP not configured: nothing to reload", "warning");
        return;
      }
      const serverID = args.trim();
      if (!serverID) {
        // 无参：重读配置并重启全部服务器
        const restarted = await service.reloadAll();
        ctx.ui.notify(
          restarted.length > 0
            ? `LSP reloaded: ${restarted.toSorted().join(", ")} restarted`
            : "LSP reloaded: servers will restart on the next tool call",
          "info",
        );
        return;
      }
      const restarted = await service.reload(serverID);
      ctx.ui.notify(
        restarted.length > 0
          ? `LSP server "${serverID}" reloaded`
          : `LSP server "${serverID}" reloaded: will restart on the next tool call`,
        "info",
      );
    },
  });

  return {
    mustLazyGetService: () => service ?? getNoopService(),
    haveEnabledLsp: () => service !== undefined,
  };
}
