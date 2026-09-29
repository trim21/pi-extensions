# Design

## Context

动机见 proposal.md。改动前的两个调用点：

**`callVision`（`src/vision-agent.ts:287-329`）**：加载图片 → 组装 `(ImageContent | TextContent)[]` → `registry.complete(model, { systemPrompt: VISION_SYSTEM_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] }, { maxTokens: model.maxTokens, signal: withTimeout(signal, REQUEST_TIMEOUT_MS) })` → `AbortError` 转 `VisionAbortError` → `contentText(result.content).trim()` + 空则报错 → 拼 `[label]\n正文\n[模型: id, tokens: N]`。

**`callNamer`（`src/session-name.ts:235-255`）**：`registry.complete(model, { systemPrompt: buildNamerPrompt(maxLength), messages: [{ role: "user", content: text, timestamp: Date.now() }] }, { maxTokens: NAMER_MAX_TOKENS, signal: withTimeout(signal, REQUEST_TIMEOUT_MS) })` → `contentText(result.content).trim()` + 空则报错。

差异（都留在各自的调用点）：systemPrompt、user content（图片分片 vs 纯文本）、maxTokens 的来源（`model.maxTokens` vs 固定常量）、后端处理（token 页脚 / 取消映射 vs 静默回退）。共同部分：registry 契约、消息封装与 `timestamp`、`maxTokens` + 超时信号的组装、正文提取与空正文判定。

调用方持有的 signal：`vision-agent` 传 `signal ?? ctx.signal`；`session-name` 传 `ctx.signal`（agent 空闲时 undefined）。两者都依赖本地超时兜底，这是 `withTimeout` 存在的理由。

## Goals / Non-Goals

**Goals:**

- registry 契约（`ModelRegistryLike`）、消息封装、超时兜底、正文提取与空正文判定各只有一个定义。
- 两个调用点只提供自己的差异（prompt、content、maxTokens、超时、signal），不重复编排。

**Non-Goals:**

- 不动 `settings.json` 的解析（`visionConfig` / `sessionName` / `spawn-agent.json` 的兜底字段）。那是「读配置」这一件事，与「发一次模型调用」不同概念；`spawn-agent-agents.ts:195` 的 `defaultProvider` 兜底因此本次不动。
- 不动 `try/catch` 的语义：`vision-agent` 把 `AbortError` 映射成 `VisionAbortError`（用户主动取消不是失败），`session-name` 在 `generateSessionName` 里把任何失败收敛成 `model-error` 回退。模块只抛原始错误，不定义取消语义。
- 不做流式（两个调用点都用非流式 `complete`）、不做重试（pi 的 registry 已负责）、不做 usage 归一化。
- 不改 `vision-agent` 的 `DEFAULT_MAX_TOKENS`（虽已无引用，但 `session-name.ts:52` 的注释指向它，删除超出本次范围）。

## Decisions

### D1 `completeText(options)` 一个函数，一个参数对象

```ts
export interface CompleteTextOptions {
  registry: ModelRegistryLike;
  model: Model<Api>;
  systemPrompt: string;
  content: UserMessage["content"];
  /** 缺省用 model.maxTokens。 */
  maxTokens?: number;
  /** 本地超时兜底：与 signal 合并；调用方不传 signal 也仍然有上限。 */
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function completeText(
  options: CompleteTextOptions,
): Promise<{ text: string; usage: Usage }>;
```

**接口宽度 ÷ 被隐藏的行为**（本仓库的判据，出自 `refactor-file-read-accounting` D1，并在 `refactor-file-touch-diagnostics` 上被实测确认）：

- 隐藏：`registry.complete` 的三参数调用形状（含 `Context` 与 user 消息封装 + `timestamp`）、`maxTokens` 的缺省与覆盖、`withTimeout` 的合并、`contentText` 提取、空正文分支与错误文案 —— 两处合计约 22 行，其中含一个分支与一个错误；以及 `ModelRegistryLike`（两份 8 行）与 `withTimeout`（两份 5 行）的重复定义。
- 接口：1 个函数、7 个字段（其中 2 个可选）、返回 2 个字段。
- 与上次被撤回的 `refactor-file-touch-diagnostics` 的关键区别：那次隐藏的是**两条无分支、无缺省、无错误的相邻语句**（5 行），调用点因此从 5 行涨到 9 行；这次隐藏的部分含分支、缺省与错误语义，调用点从 27/13 行降到约 20/9 行。判据要求的不只是字段数，而是「被隐藏的行为是否真的被收起来了」。

### D2 `maxTokens` 缺省取 `model.maxTokens`，而不是在模块里塞常量

`vision-agent` 现在传 `model.maxTokens`（模型自己的上限），`session-name` 传固定 `NAMER_MAX_TOKENS = 4096`（注释说明：推理模型会先输出思考过程，太小会在推理阶段被截断）。把「缺省 = `model.maxTokens`」放进模块，让 vision 不传、session-name 显式传自己的常量：来源的差异留在需要它的那一侧。

### D3 模块抛原始错误，取消语义留在调用方

`AbortError` 是 pi/AI SDK 的协议；`VisionAbortError` 是 vision-agent 对「用户主动取消不算失败」的表达。模块不引入第三个错误类型，也不吞异常：`registry.complete` 抛什么就抛什么。好处是 `session-name` 的「任何失败都回退」与 vision 的「区分取消与失败」都保持原样，且模块不需要知道 `vi.fn` 之外的任何策略。

### D4 返回 `{ text, usage }` 而不是整个 `AssistantMessage`

`vision-agent` 需要 `usage.totalTokens` 拼 token 页脚，`session-name` 不需要 usage。返回具体两个字段（而非宽泛的 `AssistantMessage`）让「模块对外承诺什么」显式：正文与用量。若以后需要 `stopReason` 之类，再按需要加字段，而不是先透传整个消息。

## Risks / Trade-offs

- [多一层间接] → 调用点仍直接持有 `registry` 与 `model`，模块无状态、无生命周期；回滚成本是删一个文件 + 两处改回内联。
- [超时语义被集中后不容易按调用点特化] → `timeoutMs` 是必填字段，特化仍由调用方决定（vision 300s / namer 30s）。
- [净行数上升] → 新增模块与测试的行数大于调用点减少的行数；判断依据是 D1 的比值与「不变量是否有唯一出处」，不是净行数。task 3.4 要求实测后复核这一点并如实报告。
- [`ModelRegistryLike` 换个文件导入] → 两个扩展的测试各改一行；类型本身不变（仍是鸭子类型，测试的 mock 不需要改形状）。
