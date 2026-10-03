# Design

## Context

见 `proposal.md`。几个约束塑造了实现选择：

- 宿主没有这套机制可用：本仓库装的是 `@earendil-works/pi-coding-agent` 0.87.1，它的 `ToolDefinition` 与结果类型里都没有任何结构化结果字段。pi-agent-core 0.99 有了自己的 `outputSchema` / `structuredContent`，但语义是「裸载荷 + 用 `isError` 表失败」，与本仓库要的 Result 信封不同（见 D2）。本仓库的 codemode 是自建实现（不依赖 pi 内置 codemode），因此这套机制由本仓库的 `ToolBus` 自己承载，不动 peerDependency（见 memory #28）。
- codemode 的 worker 协议把嵌套调用的结果当作 opaque JSON 传输（`HostMessage.value` 已是 `unknown`，worker 侧 `JSON.stringify`、prelude 侧 `JSON.parse`），所以让结构化结果过桥**不需要改 worker 协议**，只改 `onCall` 的取值与声明渲染。
- gh 工具的结果构造集中在 `src/gh/base.ts`：`toToolResultJson`（`content` 是原始 JSON 文本）与 `toToolResult`（文本截断），其余工具（pr-status / ci-logs / jobs / download / 两个 wait）已经在 handler 里构造了 JSON payload。

## Goals / Non-Goals

**Goals:**

- 脚本侧有统一的调用入口 `call(name, args)`，并在工具描述里看到每个工具的返回类型。
- 工具能声明自己的结构化结果，且声明只影响 codemode 脚本侧，不改变模型的 toolcall 文本输出。
- 首期覆盖 gh-readonly 中 10 个已带 JSON payload 的工具。

**Non-Goals:**

- 不给纯文本渲染的 gh 工具（`list-*` / `read-repo` / `read-release` / `read-pr-diff` / `watch-github-run`）改造成结构化输出——那需要把它们从表格文本改成 `--json`，属于后续变更。
- 不改变任何工具面向 LLM 的 `content` 文本与既有 `details`。
- 不引入对 pi 内置 codemode 或宿主结构化结果字段的依赖。

## Decisions

### D1：脚本 API 用 `call(name, args)` 取代 `tools.<name>(args)`

单个分发函数，工具名就是第一个参数：不再需要 jsName 归一化与重名处理，声明侧可以渲染成一串按字面量名字重载的 `declare function call(...)`，每个重载带着该工具的参数与返回类型。

备选：保留 `tools.<name>()`（等价于 pi 内置 codemode 的做法），但那样返回类型只能挂在属性上、又回到统一 `unknown` 的老问题，与需求 2 冲突。

prelude 侧把现在的 `tools` 对象换成一张 `name -> caller` 的 Map 加一个 `call` 函数；`ALL_TOOLS` 保留（脚本仍可在运行时枚举工具名与说明）。工具名不可用时 `call` 返回 rejected promise，错误文案与现在的「not available」一致。

### D2：`structuredSchema` / `structuredResult` 是本仓库自己的字段

`src/lib/tool-bus.ts` 新增：

```ts
export type StructuredResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface StructuredToolDefinition<TParams extends TSchema, TOutput extends TSchema, TDetails>
  extends Omit<ToolDefinition<TParams, TDetails, unknown>, "execute"> {
  structuredSchema: TOutput;
  execute(...): Promise<
    AgentToolResult<TDetails> & { structuredResult: StructuredResult<Static<TOutput>> }
  >;
}

// 单个对象字面量里 structuredSchema 推不出 execute 的上下文类型，需要 helper 兜（同 pi 的 defineTool）
export function defineStructuredTool<TParams extends TSchema, TOutput extends TSchema, TDetails>(
  definition: StructuredToolDefinition<TParams, TOutput, TDetails>,
): StructuredToolDefinition<TParams, TOutput, TDetails>;
```

- Result 只嵌在 `structuredResult` 这一个属性里，工具结果对象本身仍是单一类型；若拆成两个互斥字段，整个结果类型会分配成对象联合，读 `content` / `details` 都得先收窄。
- 字段名刻意避开宿主：pi-agent-core 0.99.2 的 `AgentToolResult` 自带 `structuredContent?: JsonValue`、`AgentTool` 自带 `outputSchema?: TSchema`，两者的语义是「`outputSchema` 就是 `structuredContent` 的 schema，失败用 `isError`」——没有 Result 信封。若沿用这两个名字，一来 TS 上会与宿主类型冲突（`AgentToolResult & { structuredContent: StructuredResult<T> }` 把 `JsonValue` 与信封求交），二来等于把信封写进宿主定义为裸载荷的字段，运行时升到 0.99 后程序化消费者（含 pi 内置 codemode）会拿到 `{ ok, value }`。所以本仓库用自己的名字，宿主字段一个不碰；将来要接宿主原生管线时显式换算即可。
- 总线在成功路径上用 `Value.Parse(structuredSchema, value)` 复核 `value`（外部数据用 typebox 校验是本仓库约定），不匹配就报错；`{ ok: false }` 分支的 `error` 是字符串，直接透传。
- `list()` / `get()` 返回带 `structuredSchema` 的定义；`register` 把同一对象交给 `pi.registerTool`，多出的 `structuredSchema` 在 0.87.1 运行时无副作用，在 >= 0.99 上也不会被当成宿主字段误读。
- 备选：直接用宿主的 `outputSchema` / `structuredContent`（裸载荷 + `isError` 表失败）。放弃原因：那会丢掉「结构化失败但不把模型侧的文本翻成 error result」这条通道，而这正是 `read-github-ci-logs` 的「job 不存在」与 release「没有资产」要表达的语义；而且运行时目前还是 0.87.1，宿主字段完全没人消费。
- 备选：两个互斥字段 `structuredOutput` / `structuredError`。放弃原因见上——整个结果类型会变成联合。

### D3：`call()` 的返回值语义

- 结果的 `structuredResult.ok === true` → 脚本 resolve 为 `value`（解包后的结构化数据）。
- `ok === false` → 脚本 reject。
- 结果不带 `structuredResult` → 回退到现在拍平的文本（string）。
- **失败统一是 `CallFailedError`**：结构化失败、参数校验失败、工具抛异常、工具名不可调用都 reject 成它（`error` / 抛错信息作为 message），脚本按 `instanceof` 就能把「工具失败」与自身的 TypeError 之类分开。该类型定义在 prelude（VM 内），所以 worker 协议不需要为错误类型加判别字段——`settle(id, false, message)` 本来就是「这次嵌套调用失败」。
- `structuredResult` 不置 `isError`：模型侧继续看到工具原来的 `content` 与 `isError` 语义。
- 声明里，声明了 `structuredSchema` 的工具返回 `Promise<该类型>`，没声明的返回 `Promise<string>`。

备选：总是返回 `{ content, details }` 信封。放弃原因：那让每个工具的返回类型都一样，模型还是看不到语义。

### D4：声明渲染改成重载 + 兜底

`declarations.ts` 为每个工具渲染一行 `declare function call(name: "<name>", args: <参数类型>): Promise<<返回类型>>;`，最后补一行 `declare function call(name: string, args?: unknown): Promise<unknown>;` 供动态名字使用（TS 重载解析按字面量名字命中具体签名）。

`renderType` 需要补一个 `const` 分支：gh schema 用 `Type.Literal` / `StringEnum`（如 `bucket: "pass" | "fail" | ...`）表达枚举，TypeBox 产出的是 `const` 而非 `enum`。

### D5：gh 工具的结构化结果

统一的实现位置在 `src/gh/base.ts`：`ToolResult` 加 `structuredResult?: StructuredResult<unknown>`；新增/扩展结果 helper 让工具把已构造的 payload 或结构化错误一并带上。

- 已经自己构造 payload 的工具（`read-github-pr-status`、`read-github-ci-logs`、`get-github-workflow-jobs`、`download-github-release-assets`、两个 wait）直接把现有 payload 包成 `{ ok: true, value }`，零解析风险。
- 纯 JSON 透传的工具（`read-github-issue`、`read-github-pr`、`read-github-issue-comments`、`read-github-pr-comments`）在 `toToolResultJson` 之后用 `Value.Parse(structuredSchema, JSON.parse(json))` 得到结构化对象（仓库约定：外部 JSON 用 typebox 校验）。schema 写得宽松——只对工具本身已经依赖的字段设 `required`，其余可选并允许额外字段——避免 GitHub 增加字段就让工具失败。
- `read-github-ci-logs` 的「job 不存在 / 仍在排队」与 `download-github-release-assets` 的「release 没有资产」两条现有文本失败路径改成 `{ ok: false, error }`，文本与 `isError` 保持不变。

各工具的输出 schema 草案（定义在 `src/gh/schemas.ts`，复用共享片段）：

| 工具                             | `structuredResult` 的 `value`                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-github-issue`              | `{ number, title, state, body, author, createdAt, updatedAt, closedAt, url, labels, assignees, comments, milestone }`                             |
| `read-github-pr`                 | 上者基础上加 `mergedAt, mergedBy, headRefName, baseRefName, additions, deletions, changedFiles, reviewRequests, reviews`                          |
| `read-github-issue-comments`     | `{ comments: GhComment[] }`                                                                                                                       |
| `read-github-pr-comments`        | `{ comments?: GhComment[]; reviews?: GhReview[] }`（默认模式只有 comments，reviews 模式两者都有）                                                 |
| `read-github-pr-status`          | `{ pr, repo, head_sha, checks: [{ name, bucket, event, run_id, job_id, url }] }`                                                                  |
| `get-github-workflow-jobs`       | `{ total_count, jobs: [{ id, run_id, run_url, name, status, conclusion, html_url, steps: [{ name, number, status, conclusion, started_at }] }] }` |
| `read-github-ci-logs`            | `{ name, id, status, conclusion, log_file, steps: [{ number, name, conclusion, start_line?, end_line? }] }`                                       |
| `download-github-release-assets` | `{ repo, tag, dir, files: [{ name, path, bytes }], available_assets? }`                                                                           |
| `wait-github-pr-checks`          | `{ status: "success" \| "failure" \| "pending", totalChecks, checks: MergedCheck[], failedJobs }`                                                 |
| `wait-github-commit-checks`      | 同上                                                                                                                                              |

## Risks / Trade-offs

- [`src/codemode/worker.js` 是提交进仓库的 esbuild 产物，prelude 改了必须重建] → 任务里显式包含 `pnpm run build:codemode-worker`；`test/codemode.test.ts` 已有 mtime 新鲜度断言兜底。
- [脚本 API 是破坏性变更] → README 与 codemode spec 同步更新；本扩展的脚本 API 未对外承诺稳定。
- [gh schema 与 GitHub 实际返回漂移] → schema 宽松（少 required、允许额外字段），透传工具用 `Value.Parse` 校验失败时按仓库既有做法报错，避免静默吞掉；测试用固定 fixture 覆盖。
- [工具描述随重载行数增长] → 每个工具一行签名（复用现有 `renderType` 只渲染仓库实际用到的形状），与现在列出每个工具的描述体量同量级；仍列为非目标的是给更多工具补 schema。

## Migration Plan

1. 先落地 codemode 机制（`call` + ToolBus 通道 + 声明渲染），此时所有工具返回 `Promise<string>`。
2. 再给 10 个 gh 工具补 `structuredSchema` 与 `structuredResult`。
3. 重建 `worker.js`，更新测试与 README。
4. 回滚策略：整体是一次提交，回退即恢复到 `tools.<name>()` 的旧实现。

## Open Questions

无。
