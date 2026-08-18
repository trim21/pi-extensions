/**
 * LSP 管理器：所有语言服务器连接的注册表与统一入口。
 *
 * - state（client 缓存、broken 集合、spawning 去重）是 createLspService 的
 *   闭包变量，不做成模块级全局；
 * - 配置来源：全局 `~/.pi/agent/lsp.json` + 本地 `<cwd>/.pi/lsp.json`
 *   （本地逐字段覆盖全局）：`servers` 数组配置驱动地定义语言服务器
 *   （按 id 与内置默认服务器合并），`enabled`/`disabled` 白名单与各超时
 *   参数继续生效；配置在每个工具的调用 cwd 下惰性读取；
 * - client 按 (root, serverID) 缓存，并发 spawn 去重，启动失败记入 broken
 *   集合（服务实例生命周期内不再重试）；
 * - 工具只与 touchFile / diagnostics / lspDiagnosticsForFile 三个方法打交道。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { type LspServerAdapter } from "./adapter.js";
import { create, type CreateInput, type Diagnostic, type Info as LspClient } from "./client.js";
import { report } from "./diagnostic.js";
import { createAdapters, serverConfigSchema } from "./server-config.js";

/** 超时值：number（毫秒，>=1）或字符串（"500"、"5s"、"1m"），Parse 后由 toMs 统一换算。 */
const timeoutValue = Type.Union([Type.Number({ minimum: 1 }), Type.String()]);

/** lsp.json 的配置项（全局与本地同构）。 */
const lspConfigSchema = Type.Object({
  /** 配置文件版本（当前 1）；未知版本会被 typebox 严格校验拒绝并回退空配置。 */
  version: Type.Optional(Type.Number()),
  /** 配置驱动的语言服务器定义（id → 配置）；按 id 与内置默认服务器合并（覆盖/enabled:false 禁用）。 */
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

/**
 * 合并后的生效配置：全局 `~/.pi/agent/lsp.json` 为基底，本地
 * `<cwd>/.pi/lsp.json` 逐字段覆盖。
 */
export async function loadLspConfig(
  cwd: string,
  globalConfigPath: string = join(homedir(), ".pi", "agent", "lsp.json"),
): Promise<LspConfig> {
  const [globalConfig, localConfig] = await Promise.all([
    readConfigFile(globalConfigPath),
    readConfigFile(join(cwd, ".pi", "lsp.json")),
  ]);
  return { ...globalConfig, ...localConfig };
}

/** 按配置过滤 adapter 列表。 */
export function filterAdapters(
  adapters: LspServerAdapter[],
  config: LspConfig,
): LspServerAdapter[] {
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
}

export interface LspService {
  touchFile(file: string, cwd: string, diagnostics?: "document" | "full"): Promise<void>;
  diagnostics(): Promise<Record<string, Diagnostic[]>>;
  lspDiagnosticsForFile(file: string, cwd: string): Promise<string>;
  shutdownAll(): Promise<void>;
  /** 绑定当前会话的 UI 上下文，LSP 服务器启动失败时用它发错误通知（传 undefined 解绑）。 */
  setUi(ui?: Pick<ExtensionUIContext, "notify">): void;
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
  const state: LspState = {
    clients: [],
    broken: new Set(),
    spawning: new Map(),
  };
  let ui: Pick<ExtensionUIContext, "notify"> | undefined;

  async function getClients(file: string, cwd: string): Promise<LspClient[]> {
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
            ui?.notify(
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
          const duplicate = state.clients.find((c) => c.root === root && c.serverID === adapter.id);
          if (duplicate) {
            await client.shutdown();
            return duplicate;
          }
          state.clients.push(client);
          return client;
        } catch (error) {
          state.broken.add(key);
          ui?.notify(
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
  ): Promise<void> {
    const clients = await getClients(file, cwd);
    await Promise.all(
      clients.map(async (client) => {
        const after = Date.now();
        const version = await client.notify.open({ path: file });
        if (!diagnostics) return;
        await client.waitForDiagnostics({ path: file, version, mode: diagnostics, after });
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
   * edit/write 用：等待文档诊断并返回该文件的 ERROR 报告（空串表示无错误）。
   * 内部所有 LSP 失败都会被吞掉，不干扰写操作本身。
   */
  async function lspDiagnosticsForFile(file: string, cwd: string): Promise<string> {
    await touchFile(file, cwd, "document");
    const all = await diagnostics();
    const normalized = normalize(file);
    return report(normalized, all[normalized] ?? []);
  }

  /** 终止全部服务器进程（session_shutdown 时调用）。 */
  async function shutdownAll(): Promise<void> {
    await Promise.all(state.clients.map((client) => client.shutdown())).catch(() => {
      // 个别进程退出失败不阻止清理流程
    });
    state.clients = [];
    state.broken.clear();
  }

  return {
    touchFile,
    diagnostics,
    lspDiagnosticsForFile,
    shutdownAll,
    setUi(nextUi) {
      ui = nextUi;
    },
  };
}

/** 注册进程级生命周期：session_shutdown 时清理全部服务器进程。 */
export function initLsp(pi: ExtensionAPI, service: LspService): void {
  // 测试里的 fake pi 没有事件订阅；生产环境 pi.on 必然存在
  pi.on?.("session_shutdown", () => {
    void service.shutdownAll();
  });
}
