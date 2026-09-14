/**
 * gh-readonly 的代理配置与请求层。
 *
 * 配置来源（配置文件优先，未写的字段回退到环境变量）：
 *   - ~/.pi/agent/gh.json: { "proxy": "http://127.0.0.1:7890", "noProxy": "localhost,.corp" }
 *   - HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（小写变体同样接受）、NO_PROXY
 *
 * 两条出口共用同一份配置，且在扩展加载时一次性读完：
 *   - gh CLI 子进程：env 给出要注入子进程的 HTTP(S)_PROXY / NO_PROXY 等变量
 *   - octokit 请求：fetch 是挂了代理 dispatcher 的 fetch；未配置代理时就是全局 fetch
 *
 * 配置有错（JSON 语法错、字段类型不符、proxy 不是 http(s) URL）直接抛错——扩展
 * 加载即失败，而不是带着一份被忽略的配置静默直连。
 */

import { readFileSync } from "node:fs";
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
export function readGhProxySettings(
  configPath: string = ghProxyConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): GhProxySettings {
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

  let file: GhProxySettings = {};
  if (raw !== undefined) {
    try {
      file = parseGhProxyConfig(JSON.parse(raw));
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
  /** 生效的代理设置（配置文件与环境变量合并后的结果）。 */
  readonly settings: GhProxySettings;
  /** 要注入 gh 子进程的代理环境变量；未配置代理时为空对象。 */
  readonly env: NodeJS.ProcessEnv;
  /** 走代理的 fetch；未配置代理时就是全局 fetch。 */
  readonly fetch: typeof globalThis.fetch;
}

/**
 * 读一次配置并组装代理层。缓存的是 dispatcher（连接池复用），**不是**
 * `globalThis.fetch` 本身：每次调用都取当前的全局 fetch，否则首个请求之后替换
 * `globalThis.fetch`（插桩、测试替身）就不再生效。
 */
export function createGhProxy(
  configPath: string = ghProxyConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): GhProxy {
  const settings = readGhProxySettings(configPath, env);
  const { proxy, noProxy } = settings;
  let dispatcher: NonNullable<RequestInit["dispatcher"]> | undefined;

  const fetch: typeof globalThis.fetch = (input, init) => {
    if (!proxy) return globalThis.fetch(input, init);
    dispatcher ??= createProxyDispatcher(proxy, noProxy);
    return globalThis.fetch(input, { ...init, dispatcher });
  };

  return { settings, env: proxyEnvVars(settings), fetch };
}
