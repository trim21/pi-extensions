# Proposal

## Why

「起一个 `gh` 进程、收集输出、超时、报错」在本仓库有两份互不相干的实现：

- `src/gh/base.ts:81-193` 的 `runGh`：带代理 env 注入、`GH_PAGER=cat`、默认 10 分钟超时、超时/中止先 SIGTERM、5 秒后 SIGKILL、`spawnError` 分类、`code ?? -1` 哨兵。
- `src/lib/github.ts:221-251` 的私有 `ghAuthToken`：另起一份 `spawn("gh", ["auth", "token"], …)`，10 秒超时、只 `SIGTERM` 没有升级、不注入 cwd / 代理 env、`stderr`/退出码自己拼错误消息。

后果：

- **两份 spawn 语义**：超时升级、env 注入、`code` 哨兵这些细节在两处各写一遍，已经不一致（token 那份没有 SIGKILL 升级）。
- **没有可注入的接缝**：token 由 `getClient()` 内部的私有函数惰性获取（`src/lib/github.ts:305-311`），`GithubClientOptions` 只能传 `fetch`。三个测试文件（`test/github-client-fetch.test.ts:15`、`test/github-jobs.test.ts:23`、`test/pr-status.test.ts:21`）为了造一个假 token 只能全局 `vi.mock("node:child_process")`，再手写 `FakeChildProcess` + `PassThrough` 假装一次进程退出。
- **依赖方向挡住了复用**：`src/gh/base.ts` 已经 import `src/lib/github.ts`（类型与 checks/search 客户端），所以 `lib/github.ts` 无法反向复用 `runGh`——直接复用会成环。这就是「同一个概念两份实现」的结构性原因：缺少一个两层都能依赖的底层 module。

## What Changes

- 新增 `src/lib/gh-process.ts`：`GhResult` / `runGh`（从 `gh/base.ts` 整体搬入，语义逐字保留）/ 代理配置单例 `httpProxy`（随 `runGh` 一起搬，因为子进程 env 由它组装）/ `ghAuthToken()`（基于 `runGh` 实现，20 行的私有副本删除）。
- `src/gh/base.ts`：删除本地 `runGh` / `GhResult` / `httpProxy` 定义，改为从 `../lib/gh-process.js` 引入；`GhClient` 增加可选的 token provider 参数并透传给 search / checks 客户端。
- `src/lib/github.ts`：删除私有 `ghAuthToken` 与 `node:child_process` 引入；`GithubClientOptions` 增加 `token?: () => Promise<string>`（缺省用 `ghAuthToken`），`getClient()` 改为调用注入的 provider。
- `src/gh/tools/watch-run.ts`、`src/gh-readonly.ts`（`ghExec` 的封装）等调用方改为从 `src/lib/gh-process.ts` 引入 `runGh`。
- 测试：三个只为一个假 token 而全局 mock 进程模块的测试改为注入 `token`；`test/run-gh-timeout.test.ts` / `test/proxy-wiring.test.ts` 的 `runGh` 导入路径改为新 module；新增 `test/gh-process.test.ts` 覆盖 `ghAuthToken` 的三条路径（成功、非零退出、spawn 失败）。
- 修正 `gh-readonly` spec 的 Implementation 段：现文写「所有工具经 `src/gh/base.ts` 的 `runGh` 封装」，实际将变为 `src/lib/gh-process.ts`。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无 Requirement 变化：gh 工具的超时、中止、代理注入、错误分类等外部行为全部保持不变；spec 的改动只是 Implementation 段里 `runGh` 的所在文件与「gh 子进程与 octokit 共用代理层」现在对 `gh auth token` 也成立这一事实，故 `.openspec.yaml` 标记 `skip_specs: true`。）

## Impact

- 代码：新增 `src/lib/gh-process.ts`；`src/gh/base.ts`、`src/lib/github.ts`、`src/gh/tools/watch-run.ts`、`src/gh-readonly.ts` 调整引入与删除本地实现。
- 规范：`openspec/specs/gh-readonly/spec.md` 的 Implementation 段一句（`runGh` 所在文件）。
- 测试：三个测试去掉 `node:child_process` 全局 mock 改为注入 token；两个测试改导入路径；新增 `test/gh-process.test.ts`。
- 一处需要记录的边界行为变化：`gh auth token` 超时（10 秒）时的错误消息从 `exited with code null` 变为 `exited with code -1`（`runGh` 的「未正常退出」哨兵），且超时现在会带上 SIGKILL 升级（与所有其它 gh 调用一致）。成功路径、非零退出路径、spawn 失败路径的消息逐字不变。
