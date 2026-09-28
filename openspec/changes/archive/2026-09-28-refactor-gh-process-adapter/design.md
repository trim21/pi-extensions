# Design

## Context

行号取自重构前。

- `src/gh/base.ts`：文件头注释声明「每个工具在 `tools/`，多处共用的东西属于这里」。`httpProxy = createHttpProxy()`（`:32`，模块级单例，注释说明 gh 子进程与 octokit 请求都从这里取）、`runGh`（`:81-193`）、`GhClient`（`:477`，`constructor(fetchImpl = httpProxy.fetch)`，把 fetch 透传给 `createGithubSearch` / `createGithubChecks`）。
- `src/lib/github.ts`：`ghAuthToken`（`:221-251`，私有）、`GithubClientOptions { fetch? }`（`:285-294`）、`createGithubApi`（`:302`，`auth: await ghAuthToken()`）、`createGithubSearch`（`:339`）/ `createGithubChecks`（`:500`）各自 `createGithubApi(options)`。
- 依赖方向：`gh/base.ts` → `lib/github.ts`（类型 + checks/search 客户端）。因此 `lib/github.ts` 不能 import `gh/base.ts`。
- 调用方：`src/gh/tools/watch-run.ts:4` 从 `../base.js` 引入 `runGh`；`src/gh/index.ts:60` `export * from "./base.js"`，`src/gh-readonly.ts` 再 `export *` 出来（因此测试从 `gh-readonly.js` 拿到 `runGh` / `GhClient`）。
- 测试现状：`test/run-gh-timeout.test.ts:28` 与 `test/proxy-wiring.test.ts:26` 从 `../src/gh-readonly.js` 引入 `runGh`；`test/gh-base.test.ts:19`、`test/github-client-fetch.test.ts:15`、`test/github-jobs.test.ts:23`、`test/pr-status.test.ts:21` 用 `vi.mock("node:child_process")` + `FakeChildProcess`（`EventEmitter` + `PassThrough`）伪造 `gh auth token`。

## Goals / Non-Goals

**Goals**

- `gh` 子进程 adapter 只有一份实现，位于两层都能依赖的 module。
- token 能从 interface 注入，测试不再 mock 进程模块。
- 超时 / kill 升级 / env 注入 / 错误分类单点维护。

**Non-Goals**

- 不改 `gh` 调用的可观察行为：默认 10 分钟超时、SIGTERM→5 秒→SIGKILL、代理 env 注入、`GH_PAGER=cat`、`code ?? -1` 哨兵、`spawnError` 分类、`ghExec` 的 JSON/文本处理与 `GhError` 都不动。
- 不改 `proxy.ts`、不改 octokit 的 fetch 注入方式。
- 不改任何 gh 工具的参数、输出或规范中的 Requirement。

## Decisions

### D1 新 module：`src/lib/gh-process.ts`

```ts
export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  combined: string;
  reason?: "timeout" | "abort";
  spawnError?: string;
}

/**
 * gh 子进程与 octokit 请求共用的代理层（配置在扩展加载时读一次；配置写错直接抛）。
 */
export const httpProxy: HttpProxy;

/** 起一个 gh 子进程并收集输出；超时/中止先 SIGTERM、5 秒后 SIGKILL。 */
export function runGh(
  args: string[],
  ctx: { cwd?: string; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<GhResult>;

/** 读系统 gh 的登录 token（`gh auth token`，10 秒超时）。 */
export function ghAuthToken(): Promise<string>;
```

- `runGh` 与其上下文（代理单例、`GhResult`）一起搬入，内容逐字保留（只把 `CTX` 类型内联到签名里，如需保持可读可命名 `GhRunContext`）。
- **代理单例跟着 `runGh` 走**：子进程 env 由 `runGh` 组装（`{...process.env, ...httpProxy.env, ...ctx.env, GH_PAGER:"cat"}`），把单例留在 `gh/base.ts` 会造成「adapter 在 lib、代理在 gh」的跨层取用；搬走后 `gh/base.ts` 的 `GhClient` 也从同一实例取 `fetch`，保持「gh 子进程与 octokit 请求共用一次配置读取」这句注释仍然成立。`src/lib/proxy.ts` 本身不改。
- `ghAuthToken` 基于 `runGh`：

```ts
export async function ghAuthToken(): Promise<string> {
  const result = await runGh(["auth", "token"], { timeout: 10_000 });
  if (result.spawnError) {
    throw new Error(`failed to start gh: ${result.spawnError}`);
  }
  const token = result.stdout.trim();
  if (result.code === 0 && token) {
    return token;
  }
  throw new Error(
    result.stderr.trim() ||
      `gh auth token exited with code ${result.code} — run "gh auth login" first`,
  );
}
```

- **考虑过的替代方案**：
  - 把 `runGh` 放进 `lib/github.ts`：`gh/base.ts` 已经 import 它，能直接用且不成环。否决——`lib/github.ts` 的职责是 octokit 客户端与响应解析，塞进子进程 adapter 会让「搜索客户端」也变成启动 gh 进程的模块，且 `gh/tools/*` 会多一条只为一件事经 `lib/github.js` 的间接依赖。
  - `runGh` 只搬函数、代理仍由 `gh/base.ts` 注入：会得到「runGh 需要调用方记得合并代理 env」的脆弱约定，或一个纯转发 wrapper。否决。
  - `httpProxy` 懒初始化（首次调用再读配置）：需要模块级可变状态，仓库约定不允许；模块级 `const` 实例与现状一致（`gh/base.ts:32` 与 `src/web/fetch.ts:29` 都是这么做的）。

### D2 `lib/github.ts` 的 token 接缝

```ts
export interface GithubClientOptions {
  fetch?: typeof globalThis.fetch;
  /** gh token provider；缺省读系统 `gh auth token`（见 lib/gh-process.ts）。 */
  token?: () => Promise<string>;
}
```

`getClient()` 改为 `auth: await (options.token ?? ghAuthToken)()`。401 重试路径（丢弃缓存 client 再试一次）继续调用同一个 provider——注入的 provider 也要能重入，测试里的假 provider 是纯函数。

**为什么不把 token 变成构造参数（`token: string`）**：现在就是惰性获取、且 401 后要重新取；provider 保留这个语义。

### D3 `GhClient` 增加 token 通道（测试入口需要）

```ts
constructor(
  fetchImpl: typeof globalThis.fetch = httpProxy.fetch,
  options: Pick<GithubClientOptions, "token"> = {},
) {
  this.fetch = fetchImpl;
  this.search = createGithubSearch({ fetch: fetchImpl, ...options });
  this.checks = createGithubChecks({ fetch: fetchImpl, ...options });
}
```

保持第一个位置参数不变（生产路径 `new GhClient()` 与既有调用零改动），token 作为可选的第二个参数；`test/pr-status.test.ts` 等经 `GhClient` 构造客户端的测试由此注入假 token。

### D4 删除本地实现后，`gh/base.ts` 不保留转发导出

`runGh` / `GhResult` 的消费者只有 `src/gh/tools/watch-run.ts` 与 `gh-readonly.ts` 的 `ghExec` 封装，直接改它们的 import 到 `../lib/gh-process.js`；`gh/index.ts` 的 `export * from "./base.js"` 不再导出 `runGh`，测试（`test/run-gh-timeout.test.ts`、`test/proxy-wiring.test.ts`）改为从 `../src/lib/gh-process.js` 引入。不加「为了兼容而转发」的 re-export。

### D5 测试改造

- **去掉全局 mock 的三个文件**：`test/github-client-fetch.test.ts`、`test/github-jobs.test.ts`、`test/pr-status.test.ts` 删除 `vi.mock("node:child_process")`、`spawnMock`、`FakeChildProcess`、`stubAuthToken` 与 `beforeEach` 里的 `spawnMock.mockImplementation`，改为在构造客户端时传 `token: async () => "test-token"`。
- **路径改动**：`test/run-gh-timeout.test.ts`、`test/proxy-wiring.test.ts` 的 `runGh` 导入改为 `../src/lib/gh-process.js`（`ghExec` / `GhError` 仍从 `gh-readonly.js`）；`test/proxy-wiring.test.ts` 对 `../src/lib/proxy.js` 的 mock 继续生效（`gh-process.ts` 从同一路径引入 `createHttpProxy`）。
- **新增** `test/gh-process.test.ts`：用 `EventEmitter` + `PassThrough` 假进程（照 `test/run-gh-timeout.test.ts` 的写法）覆盖 `ghAuthToken` 三条路径——成功（stdout 带换行需 trim）、非零退出（stderr 优先，缺 stderr 时用 `exited with code N — run "gh auth login" first`）、spawn 失败（`failed to start gh: …`），并断言它以 10 秒超时调用 `runGh`（可用假进程 + 假计时器或断言 `spawn` 收到的参数不含 `--version` 之类，具体方式由实现者择一并在报告里说明）。

## Risks / Trade-offs

- **`httpProxy` 换文件**：`test/proxy-wiring.test.ts` 靠 `vi.mock("../src/lib/proxy.js")` 生效，路径不变所以仍然有效；但任何按「从 `gh/base.js` 取 `httpProxy`」的假设都会失效——已确认 src/ 内无此引用（只有 `src/web/fetch.ts` 自己的实例）。
- **`ghAuthToken` 超时消息从 `null` 变 `-1`**：这是唯一可见的行为差异，方向是变准（`-1` 是 `runGh` 文档化的「未正常退出」哨兵）；proposal 已记录。
- **`lib/gh-process.ts` 引入即读代理配置**：`lib/github.ts` 现在会间接持有 `httpProxy` 单例（模块加载即读一次 proxy.json）。gh 工具路径本来就会加载 `gh/base.ts` 并读一次，所以生产路径没有变化；直接 import `lib/github.ts` 的测试会多一次无害的配置读取（配置缺失/格式错误时抛错，与 gh 层行为一致）。
