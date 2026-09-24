/**
 * HTTP 代理层：gh-readonly 与 web_fetch 共用的出网配置。
 *
 * 配置来源（配置文件优先，未写的字段回退到环境变量）：
 *   - ~/.pi/agent/proxy.json: { "proxy": "http://127.0.0.1:7890", "noProxy": "localhost,.corp" }
 *   - HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（小写变体同样接受）、NO_PROXY
 *
 * 这份配置是全局出网代理，不专属 GitHub：gh 子进程、octokit 请求、web_fetch 都走它。
 *
 * 三条出口共用同一份配置，且在扩展加载时一次性读完：
 *   - gh CLI 子进程：env 给出要注入子进程的 HTTP(S)_PROXY / NO_PROXY 等变量
 *   - octokit 请求：fetch 是挂了代理 dispatcher 的 fetch（octokit 只认自定义 fetch）
 *   - web_fetch：同样用 fetch（Node 的全局 fetch 不认 HTTPS_PROXY 环境变量）
 *
 * 未配置代理时 fetch 就是全局 fetch。配置有错（JSON 语法错、字段类型不符、proxy 不是
 * http(s) URL）直接抛错——扩展加载即失败，而不是带着一份被忽略的配置静默直连。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

import { parseWithSchema } from "./parse-with-schema.js";

const proxyConfigSchema = Type.Object({
  proxy: Type.Optional(Type.String()),
  noProxy: Type.Optional(Type.String()),
});

export interface HttpProxySettings {
  /** 代理 URL（http/https）；undefined 表示不使用代理。 */
  proxy?: string;
  /** 不走代理的 host 列表（逗号分隔），语义同 NO_PROXY。 */
  noProxy?: string;
}

export function proxyConfigPath(): string {
  return join(homedir(), ".pi", "agent", "proxy.json");
}

/** 解析 proxy.json 的内容；字段类型不符时抛出带字段路径的错误。 */
export function parseProxyConfig(value: unknown): HttpProxySettings {
  const parsed = parseWithSchema(proxyConfigSchema, value);
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
function normalizeProxy(value: string): string {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new Error(`invalid proxy URL: ${value}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`unsupported proxy protocol: ${value} (expected http:// or https://)`);
  }
  return value;
}

/**
 * 同步读配置：扩展加载时调用一次（node:fs/promises 在同步的初始化路径上用不了，
 * 这里是仓库里允许的同步例外）。文件不存在 = 未配置；文件读不了、JSON 非法或
 * 字段不符都直接抛。
 */
export function readProxySettings(
  configPath: string = proxyConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): HttpProxySettings {
  let raw: string | undefined;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`${configPath}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  let file: HttpProxySettings = {};
  if (raw !== undefined) {
    try {
      file = parseProxyConfig(JSON.parse(raw));
    } catch (error) {
      throw new Error(`${configPath}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  const proxy = file.proxy ?? firstEnv(PROXY_ENV_NAMES, env);
  const noProxy = file.noProxy ?? firstEnv(NO_PROXY_ENV_NAMES, env);
  return {
    ...(proxy && { proxy: normalizeProxy(proxy) }),
    ...(noProxy && { noProxy }),
  };
}

/** 要注入 gh 子进程的代理环境变量；未配置代理时为空对象（子进程继承父进程环境）。 */
export function proxyEnvVars(settings: HttpProxySettings): NodeJS.ProcessEnv {
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
function createProxyDispatcher(proxy: string, noProxy: string | undefined): EnvHttpProxyAgent {
  return new EnvHttpProxyAgent({
    httpProxy: proxy,
    httpsProxy: proxy,
    // undici 8 起只有 https 目标默认走 CONNECT 隧道，http 目标改为 absolute-form
    // 转发；这里保持隧道语义统一，http 与 https 一律 CONNECT。
    proxyTunnel: true,
    ...(noProxy && { noProxy }),
  });
}

export interface HttpProxy {
  /** 生效的代理设置（配置文件与环境变量合并后的结果）。 */
  readonly settings: HttpProxySettings;
  /** 要注入 gh 子进程的代理环境变量；未配置代理时为空对象。 */
  readonly env: NodeJS.ProcessEnv;
  /** 请求用的 fetch：undici 的 fetch，配置了代理时挂上 dispatcher。 */
  readonly fetch: typeof globalThis.fetch;
}

/**
 * 读一次配置并组装代理层。请求一律走 undici 自己的 fetch——undici 8 的 dispatcher
 * 换了 handler 协议，Node 全局 fetch 挂不上它（抛 `invalid onRequestStart method`），
 * 所以测试替身 mock undici 的 fetch 即可覆盖全部请求。缓存的是 dispatcher（连接池
 * 复用），不是 fetch 本身。
 */
export function createHttpProxy(
  configPath: string = proxyConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): HttpProxy {
  const settings = readProxySettings(configPath, env);
  const { proxy, noProxy } = settings;
  let dispatcher: EnvHttpProxyAgent | undefined;

  const fetch: typeof undiciFetch = (input, init) => {
    if (!proxy) return undiciFetch(input, init);
    dispatcher ??= createProxyDispatcher(proxy, noProxy);
    return undiciFetch(input, { ...init, dispatcher });
  };

  return {
    settings,
    env: proxyEnvVars(settings),
    // undici 的 fetch 与 Node 全局 fetch（@types/node 走 undici-types）各带一份
    // Request/Response 类型声明，结构一致但对不上；调用方只传 string | URL，
    // 这里只做类型层面的转换。
    fetch: fetch as typeof globalThis.fetch,
  };
}
