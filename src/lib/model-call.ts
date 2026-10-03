/**
 * 经 pi 的模型注册表发起一次文本生成调用（非流式）。
 *
 * 需要「让某个模型把一段内容变成一段文本」的扩展都走这里，因为有几件事
 * 只有在同一处才对：
 * - registry 的契约（下面 `ModelRegistryLike` 是鸭子类型，只声明用到的方法）；
 * - user 消息的封装（`content` + `timestamp`，模型侧看到的形状每次一致）；
 * - 本地超时兜底：`ctx.signal` 在 agent 空闲时为 undefined，只依赖它就没上限，
 *   所以这里把调用方 signal 与 `timeoutMs` 合并；
 * - 正文提取与空正文判定：只看 `contentText`（推理模型的 thinking 不算正文），
 *   空正文是失败而不是空结果。
 *
 * 不在这里的：取消语义（调用方各自决定 `AbortError` 意味着什么）、流式、
 * 重试（registry 自己负责）、以及各扩展自己的 prompt 与后处理。
 */

import {
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  contentText,
  type Context,
  type Model,
  type Usage,
  type UserMessage,
} from "@earendil-works/pi-ai";

import { withTimeoutSignal } from "./abort.js";

/**
 * 模型注册表操作：扩展传 `ctx.modelRegistry`，测试传 mock。
 * 结构化类型（duck typing），只声明用到的两个方法。
 */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<Api> | undefined;
  complete(
    model: Model<Api>,
    context: Context,
    options?: ApiStreamOptions<Api> & { signal?: AbortSignal },
  ): Promise<AssistantMessage>;
}

export interface CompleteTextOptions {
  registry: ModelRegistryLike;
  model: Model<Api>;
  systemPrompt: string;
  /** user 消息内容：纯文本，或文本 / 图片分片数组。 */
  content: UserMessage["content"];
  /** 输出上限；缺省用 `model.maxTokens`。 */
  maxTokens?: number;
  /** 本地超时兜底：与 `signal` 合并，调用方不传 signal 时也仍然有上限。 */
  timeoutMs: number;
  /** 调用方的取消信号（例如 `ctx.signal`，agent 空闲时为 undefined）。 */
  signal?: AbortSignal;
}

export interface CompleteTextResult {
  /** 模型输出的正文（已 trim；thinking 块不计入）。 */
  text: string;
  usage: Usage;
}

/**
 * 用给定模型生成正文。`registry.complete` 抛出的错误原样向上抛（含
 * `AbortError`），取消与失败的区分由调用方决定。
 */
export async function completeText(options: CompleteTextOptions): Promise<CompleteTextResult> {
  const result = await options.registry.complete(
    options.model,
    {
      systemPrompt: options.systemPrompt,
      messages: [
        { role: "user", content: options.content, timestamp: Date.now() } satisfies UserMessage,
      ],
    },
    {
      maxTokens: options.maxTokens ?? options.model.maxTokens,
      signal: withTimeoutSignal(options.signal, options.timeoutMs),
    },
  );
  const text = contentText(result.content).trim();
  if (!text) {
    throw new Error("API 未返回内容");
  }
  return { text, usage: result.usage };
}
