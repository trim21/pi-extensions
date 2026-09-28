# Design

## Context

行号取自重构前。

- `src/lib/proxy.ts`：`HttpProxySettings`（`:33`）、`proxyEnvVars`（`:127`）、`HttpProxy { settings; env; fetch }`（`:162-171`）、`createHttpProxy(configPath?, env?)`（`:177`，读一次配置，`fetch` 是 undici 的 fetch，配了代理就挂 `EnvHttpProxyAgent` dispatcher，NO_PROXY 由 dispatcher 处理）。
- `src/lib/gh-process.ts:16`（上一处改动搬入的）`export const httpProxy = createHttpProxy()`，`runGh` 用 `httpProxy.env` 组装子进程 env（`{...process.env, ...httpProxy.env, ...ctx.env, GH_PAGER:"cat"}`）。
- `src/gh/base.ts:347` 的 `GhClient` 缺省 `fetchImpl = httpProxy.fetch`（从 `gh-process.js` 引入）。
- `src/web/fetch.ts:29` `const httpProxy = createHttpProxy()`；`web_fetch` 的所有请求经 `httpProxy.fetch`。文件头注释解释了「Node 全局 fetch 不认代理环境变量」。
- `src/web/search.ts:153` `searchWeb` 直接用全局 `fetch` 发 Search1API 请求。
- 测试：`test/web-fetch.test.ts:22` mock `undici`；`test/web-fetch-download.test.ts:18` mock `../src/lib/proxy.js` 的 `createHttpProxy`；`test/web-search.test.ts:107` `vi.stubGlobal("fetch", …)`；`test/proxy-wiring.test.ts:21` 也 mock `../src/lib/proxy.js`。

## Goals / Non-Goals

**Goals**

- 「出网」有归属：所有出网调用方从同一处取 `fetch` / 子进程代理 env，接线只在一处。
- 消掉 `web_search` 的全局 fetch 泄漏，让 web spec 的 Purpose 成立。
- 测试的拦截点收敛到这一处。

**Non-Goals**

- 不改 `lib/proxy.ts` 的代理解析与 dispatcher 逻辑（NO_PROXY、CONNECT 隧道、缓存策略都不动）。
- 不改 `web_fetch` / `web_search` / `gh` 调用的超时、重试、错误文案与请求构造。
- 不把出网抽成「按 host 选择 fetch」的形状：代理与 NO_PROXY 的分流已经在 dispatcher 里，interface 再暴露 host 判断只会重复它。
- 不改 `src/openai-cost/` 的 fetch 接线（那是用量捕获，不是出网代理；不属于本次范围）。

## Decisions

### D1 `src/lib/egress.ts` 的 interface

```ts
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
```

- **同时导出工厂与共享实例**：工厂让「需要独立配置的测试或未来调用方」不必 mock 模块（`proxy.ts` 本身也是这个形状），共享实例让生产调用方零接线。工厂的返回类型是 `Egress` 而不是 `HttpProxy`，这样调用方拿不到 `settings` 之外的代理细节，也就不会绕过这层自己判断。
- **`settings` 为什么留在 interface 里**：`web_fetch` 的错误提示与 `gh` 的启动日志会用到「当前是否配置了代理」；它是只读元数据，不影响「只能用这个 fetch」的约束。
- **考虑过的替代方案**：
  - 让调用方接收 `Egress` 参数（`webFetchTool(pi, egress)`、`searchWeb(q, key, {egress})`）：真正的依赖注入，但生产入口是扩展注册函数，注入点只能到模块默认值那一层，收益被 `vi.mock("../src/lib/egress.js")` 覆盖，而 `searchWeb` 的签名要跟着变（它的调用方与测试都在同一文件内）。否决，取共享实例 + 模块 mock。
  - 按 host 暴露 `fetchFor(host)`：dispatcher 已经处理 NO_PROXY；多一层只会在两处表达同一条规则。否决。
  - 把 `lib/proxy.ts` 直接改名成 `egress.ts`：会让「代理适配器的实现细节」（解析、dispatcher、缓存）与「出网入口」混成一个 module，且 gh 的 `env` 组装与 undici 细节会一起暴露给所有调用方。否决，保留 `proxy.ts` 作适配器、`egress.ts` 作入口。

### D2 调用方改造

| 文件                    | 现在                                         | 改后                                                                                          |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/web/search.ts`     | 全局 `fetch`                                 | `egress.fetch`（`import { egress } from "../lib/egress.js"`）                                 |
| `src/web/fetch.ts`      | `const httpProxy = createHttpProxy()`        | 删除本地实例，用 `egress.fetch`（文件头注释里的「代理层」改为「共享出网层 `lib/egress.ts`」） |
| `src/lib/gh-process.ts` | `export const httpProxy = createHttpProxy()` | 删除导出，`runGh` 的子进程 env 用 `egress.env`                                                |
| `src/gh/base.ts`        | `fetchImpl = httpProxy.fetch`                | `fetchImpl = egress.fetch`                                                                    |

`src/lib/proxy.ts` 不改：它仍是「代理适配器」，改动后只被 `egress.ts` 调用（`grep -rn "createHttpProxy" src/` 应只剩 `proxy.ts` 定义与 `egress.ts` 调用）。

### D3 测试

- `test/web-search.test.ts`：`vi.stubGlobal("fetch", …)` 换成 `vi.mock("../src/lib/egress.js", () => ({ egress: { settings: {}, env: {}, fetch: egressFetch } }))`（`egressFetch` 用 `vi.hoisted` 提升），断言保持（URL / method / Authorization / body）。**新增回归用例**：把 `globalThis.fetch` 换成抛错的函数，`searchWeb` 仍成功返回——这正是「泄漏到全局 fetch」的钉子（改动前该用例失败）。
- `test/web-fetch-download.test.ts`、`test/proxy-wiring.test.ts`：它们 mock `../src/lib/proxy.js`，而 `egress.ts` 正是从那里取适配器，因此无需改动；`test/web-fetch.test.ts` mock `undici`，egress 走的是 undici 的 fetch，同样无需改动。**但要实跑确认**（若某个 mock 因模块图变化失效，改 mock 目标为 `egress.js` 并在报告里说明）。
- 新增 `test/egress.test.ts`：mock `../src/lib/proxy.js` 返回一个带标记的假适配器（`settings` / `env` / `fetch` 三个可辨识值），断言 `createEgress()` 把三者原样透出；再断言配置错误（`createHttpProxy` 抛）时 `createEgress()` 也抛，即不静默直连。

### D4 规范改动

- delta（`specs/web/spec.md`）：MODIFIED Requirement「出网代理」——范围从「`web_fetch` 的请求」扩展为「所有出网请求（`web_fetch` 抓取与 `web_search` 搜索）都从共享出网层 `src/lib/egress.ts` 发出」，并新增 `web_search` 的 scenario。
- 主 spec 的 Implementation 段（非 Requirement，直接改）：`web/spec.md:112` 的「请求经 `src/lib/proxy.ts` 的 `createHttpProxy().fetch` 发出」→ 经共享出网层 `src/lib/egress.ts` 的 `fetch`；`:114` 的「与 gh-readonly 共用」→ 补 egress；`:116` 的涉及文件加 `src/lib/egress.ts`。`gh-readonly/spec.md:191` 的代理句与 `:195` 的涉及文件同步为经 `src/lib/egress.ts`。

## Risks / Trade-offs

- **`web_search` 首次加载会读代理配置**：`search.ts` 是独立扩展入口，import `egress` 即触发一次 `createHttpProxy()`（读 `proxy.json` + 环境变量）。这是修复的前提（要经代理就必须先知道代理配置），成本是一次文件读取；配置写错时现在会**在加载时报错**而不是静默直连——与 `web_fetch` / `gh` 层既有行为一致。
- **无代理时 fetch 实现从 Node 全局 fetch 变为 undici 的 fetch**：`web_search` 的请求在未配置代理时由 undici 发出。两者都是标准 fetch，超时/abort 语义相同（`AbortSignal.timeout` 由 undici 支持）；差异只在错误消息文本（如 `fetch failed` 的 cause 链）。为这一影响面提供了回归用例与实跑验证。
- **`test/web-search.test.ts` 的 mock 从全局 fetch 变成模块 mock**：断言里对 `fetch` 调用参数的检查不变，但 mock 生效方式依赖 vitest 模块 mock 的顺序（必须在 import 被测模块之前 `vi.mock`）——照现有 `test/web-fetch-download.test.ts` 的写法即可。
- **`egress.ts` 是薄层**：删掉它，各调用方又会各自 `createHttpProxy()` 并自行决定用哪个 fetch（`web_search` 已经这么错过一次）。它承载的是「出网只有一个入口」这条约束，不是代码量。
