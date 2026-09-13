/**
 * gh-readonly 的代理配置与请求层。
 *
 * 配置来源（配置文件优先，未写的字段回退到环境变量）：
 *   - ~/.pi/agent/gh.json: { "proxy": "http://127.0.0.1:7890", "noProxy": "localhost,.corp" }
 *   - HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（小写变体同样接受）、NO_PROXY
 *
 * 两条出口共用同一份配置：
 *   - gh CLI 子进程：env() 给出要注入子进程的 HTTP(S)_PROXY / NO_PROXY 等变量
 *   - octokit 请求：fetch 是挂了代理 dispatcher 的 fetch；未配置代理时就是全局 fetch
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { EnvHttpProxyAgent } from "undici";

import { parseWithSchema } from "./parse-with-schema.js";

const ghConfigSchema = Type.Object({
  proxy: Type.Optional(Type.String()),
  noProxy: Type.Optional(Type.String()),
});

export interface GhProxySettings {
  /** 代理 URL（http/https）；undefined 表示不使用代理。 */
  proxy?: string;
  /** 不走代理的 host 列表（逗号分隔），语义同 NO_PROXY。 */
  noProxy?: string;
}

export function ghProxyConfigPath(): string {
  return join(homedir(), ".pi", "agent", "gh.json");
}

/** 解析 gh.json 的内容；字段类型不符时抛出带字段路径的错误。 */
export function parseGhProxyConfig(value: unknown): GhProxySettings {
  const parsed = parseWithSchema(ghConfigSchema, value);
  const proxy = parsed.proxy?.trim();
  const noProxy = parsed.noProxy?.trim();
  return { ...(proxy && { proxy }), ...(noProxy && { noProxy }) };
}

const PROXY_ENV_NAMES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

const NO_PROXY_ENV_NAMES = ["NO_PROXY", "no_proxy"];

function firstEnv(names: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** 代理必须是 http(s) URL：undici 的 ProxyAgent 只支持 HTTP CONNECT 代理。 */
function normalizeProxy(value: string | undefined): { proxy?: string; error?: string } {
  if (!value) return {};
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return { error: `invalid proxy URL: ${value}` };
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return { error: `unsupported proxy protocol: ${value} (expected http:// or https://)` };
  }
  return { proxy: value };
}

export interface GhProxyLoad {
  /** 生效的代理设置（配置文件与环境变量合并后的结果）。 */
  settings: GhProxySettings;
  /** 配置读取/解析失败的原因；未失败时为 undefined。 */
  error?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读配置文件；文件不存在视为未配置，其它失败只记录不抛出。 */
async function readConfigFile(configPath: string): Promise<GhProxyLoad> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {} };
    return { settings: {}, error: `${configPath}: ${describeError(error)}` };
  }
  try {
    return { settings: parseGhProxyConfig(JSON.parse(raw)) };
  } catch (error) {
    return { settings: {}, error: `${configPath}: ${describeError(error)}` };
  }
}

async function resolveSettings(configPath: string, env: NodeJS.ProcessEnv): Promise<GhProxyLoad> {
  const file = await readConfigFile(configPath);
  const normalized = normalizeProxy(file.settings.proxy ?? firstEnv(PROXY_ENV_NAMES, env));
  const noProxy = file.settings.noProxy ?? firstEnv(NO_PROXY_ENV_NAMES, env);
  return {
    settings: { ...(normalized.proxy && { proxy: normalized.proxy }), ...(noProxy && { noProxy }) },
    error: file.error ?? normalized.error,
  };
}

/** 要注入 gh 子进程的代理环境变量；未配置代理时为空对象（子进程继承父进程环境）。 */
export function proxyEnvVars(settings: GhProxySettings): NodeJS.ProcessEnv {
  const { proxy, noProxy } = settings;
  if (!proxy) return {};
  return {
    // gh 是 Go 程序，https 目标只认 HTTPS_PROXY；统一填全部变量，避免用户只设了
    // HTTP_PROXY 时 https 请求直连。小写变体给 curl 系的子进程用。
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    ...(noProxy && { NO_PROXY: noProxy, no_proxy: noProxy }),
  };
}

/**
 * 代理 dispatcher：NO_PROXY 匹配、CONNECT 隧道都交给 undici 的
 * EnvHttpProxyAgent，octokit 侧只认自定义 fetch（v5 丢掉了 node-fetch 时代的
 * `agent` 选项，@octokit/request 的选项里没有这个字段，也没有任何地方把它转交给
 * fetch），所以代理只能从 fetch 挂进去。
 */
function createProxyDispatcher(
  proxy: string,
  noProxy: string | undefined,
): NonNullable<RequestInit["dispatcher"]> {
  // undici 包与 Node 全局 fetch 各带一份 Dispatcher 类型声明（@types/node 走
  // undici-types），结构一致但 compose 重载对不上，这里只做类型层面的转换。
  return new EnvHttpProxyAgent({
    httpProxy: proxy,
    httpsProxy: proxy,
    ...(noProxy && { noProxy }),
  }) as unknown as NonNullable<RequestInit["dispatcher"]>;
}

export interface GhProxy {
  /** 读取配置（首个调用触发读盘，之后返回同一个缓存结果，失败不抛出）。 */
  load(): Promise<GhProxyLoad>;
  /** 要注入 gh 子进程的代理环境变量；未配置代理时为空对象。 */
  env(): Promise<NodeJS.ProcessEnv>;
  /** 走代理的 fetch；未配置代理时就是全局 fetch。 */
  readonly fetch: typeof globalThis.fetch;
}

/**
 * 创建代理配置读取器。配置只在首次使用时读一次并缓存；`load` 与 `fetch` 共用这次
 * 读取，因此运行期不会出现两者看到不同配置的情况。
 *
 * 缓存的是 dispatcher（连接池复用），**不是** `globalThis.fetch` 本身：每次调用都
 * 取当前的全局 fetch，否则首个请求之后替换 `globalThis.fetch`（插桩、测试替身）
 * 就不再生效。
 */
export function createGhProxy(
  configPath: string = ghProxyConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): GhProxy {
  let loading: Promise<GhProxyLoad> | undefined;
  let dispatcher: NonNullable<RequestInit["dispatcher"]> | undefined;

  function load(): Promise<GhProxyLoad> {
    loading ??= resolveSettings(configPath, env);
    return loading;
  }

  return {
    load,
    env: async () => {
      const { settings } = await load();
      return proxyEnvVars(settings);
    },
    fetch: async (input, init) => {
      const { settings } = await load();
      const { proxy, noProxy } = settings;
      if (!proxy) return globalThis.fetch(input, init);
      dispatcher ??= createProxyDispatcher(proxy, noProxy);
      return globalThis.fetch(input, { ...init, dispatcher });
    },
  };
}
