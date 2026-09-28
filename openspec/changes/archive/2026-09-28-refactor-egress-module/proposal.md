# Proposal

## Why

「向外发请求」在本仓库有五个相关 module，但没有任何一处是「出网」这件事的归属地：

- `src/lib/proxy.ts` 代理适配器：把 `settings` / `env` / `fetch` 三件分开暴露（`:162-171`）。
- `src/gh/base.ts:32` 与 `src/web/fetch.ts:29` 各自 `createHttpProxy()` 造一个模块级实例。
- `src/gh/base.ts` 的 `gh` 子进程与 octokit 请求都从实例取（上一处改动后这个实例在 `src/lib/gh-process.ts`）。
- **`src/web/search.ts:153` 的 `searchWeb` 用全局 `fetch`**：配了代理也直连。而 `proxy.ts:13` 明确写着 Node 的全局 fetch 不认 `HTTPS_PROXY` / `ALL_PROXY`，`web/fetch.ts` 的文件头注释也解释了为什么必须挂代理（沙箱内只经代理可达的 host）。

也就是说：每个出网调用方都得自己知道「要用代理 fetch，不能用全局 fetch」，而 `web_search` 已经忘了这件事——这不是疏忽的个例，是缺少一处归属的结果。测试层面同样发散：同一个概念被三套方式拦截（`test/web-fetch.test.ts` mock undici、`test/web-fetch-download.test.ts` mock `lib/proxy.js`、`test/web-search.test.ts` stub `globalThis.fetch`）。

## What Changes

- 新增 `src/lib/egress.ts`：出网的单一入口，interface 只回答两件事——请求用哪个 `fetch`、给子进程注入哪些代理环境变量（外加 `settings` 供诊断）。共享实例 `egress` 在扩展加载时读一次代理配置。
- `src/web/search.ts`：`searchWeb` 改用 `egress.fetch`——**这是本次唯一的行为变化**：配了代理时 `web_search` 请求经代理发出（此前一律直连）。
- `src/web/fetch.ts`、`src/lib/gh-process.ts`、`src/gh/base.ts`：改用共享 `egress`（`fetch` / `env`），删除各自的 `createHttpProxy()` 实例与 `httpProxy` 导出。
- 测试：`test/web-search.test.ts` 从 stub 全局 fetch 改为 mock egress module，并补一条回归用例（全局 `fetch` 换成会抛错的函数时 `searchWeb` 仍成功）；新增 `test/egress.test.ts` 钉住 egress 的三个字段来自代理适配器。
- 规范：`web` capability 的「出网代理」Requirement 从只覆盖 `web_fetch` 扩展为覆盖全部出网调用（`web_fetch` + `web_search`），并把 Implementation 段的 `createHttpProxy().fetch` 描述改为经 `src/lib/egress.ts`；`gh-readonly` spec 的 Implementation 段同步（代理层经 egress）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `web`：「出网代理」Requirement 的适用范围从 `web_fetch` 扩到 `web_search`（见 `specs/web/spec.md` 的 delta）。这是真实的行为变化：`web_search` 从此尊重 `~/.pi/agent/proxy.json` / `HTTPS_PROXY`。spec 的 Purpose 本来就写「出网统一走共享代理层」，此前只有 `web_fetch` 成立。

## Impact

- 代码：新增 `src/lib/egress.ts`；`src/web/search.ts`、`src/web/fetch.ts`、`src/lib/gh-process.ts`、`src/gh/base.ts` 改为经共享 egress；`src/lib/proxy.ts` 本身不改（它仍是代理适配器的实现，只是被 egress 独占调用）。
- 规范：`openspec/specs/web/spec.md` 的 Requirement 与 Implementation 段、`openspec/specs/gh-readonly/spec.md` 的 Implementation 段。
- 测试：`test/web-search.test.ts` 改造 + 回归用例；新增 `test/egress.test.ts`；其余 mock `lib/proxy.js` / `undici` 的测试预期无需改动（egress 仍从 `lib/proxy.js` 取适配器）。
- 依赖与配置格式不变；`web_search` 经代理后请求的发起方从 Node 全局 fetch 变为 undici 的 fetch（无代理时等价直连）。
