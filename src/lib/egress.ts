/**
 * 出网入口：代理配置的解析、dispatcher 与 NO_PROXY 分流仍在 `src/lib/proxy.ts`（代理
 * 适配器），本模块只把它收敛成一处，让所有出网调用方从同一处取 `fetch` 与子进程代理
 * 环境变量，并保持「配置写错即加载失败」的行为——不静默直连。
 */

import { createHttpProxy, type HttpProxySettings } from "./proxy.js";

/**
 * 出网的单一入口：需要的调用方从这里取请求用的 fetch 与子进程代理环境变量，
 * 不必各自判断「该用代理 fetch 还是全局 fetch」。
 */
export interface Egress {
  /** 生效的代理设置，供诊断与展示。 */
  readonly settings: HttpProxySettings;
  /** 请求用的 fetch：undici 的 fetch，配置了代理时自动走代理（NO_PROXY 由 dispatcher 处理）。 */
  readonly fetch: typeof globalThis.fetch;
  /** 要注入子进程的代理环境变量；未配置代理时为空对象。 */
  readonly env: NodeJS.ProcessEnv;
}

/** 组装出网层（读一次代理配置；配置写错直接抛）。 */
export function createEgress(): Egress {
  const proxy = createHttpProxy();
  return { settings: proxy.settings, fetch: proxy.fetch, env: proxy.env };
}

/** 共享出网实例：进程内所有出网调用方共用（代理配置在扩展加载时读一次）。 */
export const egress: Egress = createEgress();
