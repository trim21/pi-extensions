/**
 * model-call：经 pi 的模型注册表发起一次文本生成调用。
 *
 * 钉住模块自己的契约：maxTokens 的缺省与覆盖、user 消息封装、超时与调用方
 * signal 的合并、正文提取（thinking 不算正文）、空正文报错、usage 透传、以及
 * 「registry 抛什么就抛什么」（含 AbortError，不在这里定义取消语义）。
 *
 * 两个扩展侧的端到端行为（callVision / callNamer 的 prompt、maxTokens、signal）
 * 仍由 test/vision-agent.test.ts 与 test/session-name.test.ts 覆盖。
 */
import type { Api, AssistantMessage, Context, Model, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { completeText, type ModelRegistryLike } from "../src/lib/model-call.js";

interface CompleteCall {
  model: Model<Api>;
  context: Context;
  options: { maxTokens: number; signal: AbortSignal };
}

/** complete 返回指定 content 的 registry 桩，并记录每次调用的参数 */
function registryMock(
  content: AssistantMessage["content"],
  usage: Partial<AssistantMessage["usage"]> = {},
): ModelRegistryLike & { complete: ReturnType<typeof vi.fn> } {
  return {
    find: (): Model<Api> | undefined => undefined,
    complete: vi.fn(
      async () =>
        ({
          content,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7, ...usage },
        }) as unknown as AssistantMessage,
    ),
  };
}

function callsOf(
  registry: ModelRegistryLike & { complete: ReturnType<typeof vi.fn> },
): CompleteCall[] {
  return registry.complete.mock.calls.map(
    (call: unknown[]) =>
      ({
        model: call[0],
        context: call[1],
        options: call[2],
      }) as CompleteCall,
  );
}

function modelMock(id = "mimo", maxTokens = 4096): Model<Api> {
  return { id, maxTokens } as Model<Api>;
}

describe("completeText", () => {
  it("缺省用 model.maxTokens，显式传值覆盖它", async () => {
    const registry = registryMock([{ type: "text", text: "ok" }]);
    await completeText({
      registry,
      model: modelMock("m", 8192),
      systemPrompt: "sys",
      content: "hi",
      timeoutMs: 1000,
    });
    await completeText({
      registry,
      model: modelMock("m", 8192),
      systemPrompt: "sys",
      content: "hi",
      maxTokens: 4096,
      timeoutMs: 1000,
    });

    const [first, second] = callsOf(registry);
    expect(first?.options.maxTokens).toBe(8192);
    expect(second?.options.maxTokens).toBe(4096);
  });

  it("把 systemPrompt 与 user 消息（content + timestamp）交给 registry", async () => {
    const registry = registryMock([{ type: "text", text: "ok" }]);
    const content: UserMessage["content"] = [
      { type: "text", text: "看图" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ];
    await completeText({
      registry,
      model: modelMock(),
      systemPrompt: "sys",
      content,
      timeoutMs: 1000,
    });

    const call = callsOf(registry)[0];
    expect(call?.context.systemPrompt).toBe("sys");
    expect(call?.context.messages).toEqual([
      { role: "user", content, timestamp: expect.any(Number) },
    ]);
  });

  it("不传 signal 时仍然有超时兜底", async () => {
    const registry = registryMock([{ type: "text", text: "ok" }]);
    await completeText({
      registry,
      model: modelMock(),
      systemPrompt: "sys",
      content: "hi",
      timeoutMs: 5,
    });

    const signal = callsOf(registry)[0]?.options.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    // 超时是真实计时器（不是假时钟）：等到它触发，超过窗口未触发会让本用例超时失败
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    expect(signal?.aborted).toBe(true);
  });

  it("调用方 signal 与超时合并：调用方取消会传导给 registry", async () => {
    const registry = registryMock([{ type: "text", text: "ok" }]);
    const controller = new AbortController();
    await completeText({
      registry,
      model: modelMock(),
      systemPrompt: "sys",
      content: "hi",
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    const signal = callsOf(registry)[0]?.options.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("只取 text 块作为正文，thinking 不算结果", async () => {
    const registry = registryMock([
      { type: "thinking", thinking: "先想想用户要什么" } as never,
      { type: "text", text: "  修复登录bug  " },
    ]);
    const result = await completeText({
      registry,
      model: modelMock(),
      systemPrompt: "sys",
      content: "hi",
      timeoutMs: 1000,
    });
    expect(result.text).toBe("修复登录bug");
  });

  it("空正文（含只有 thinking）报 API 未返回内容", async () => {
    const empty = registryMock([]);
    await expect(
      completeText({
        registry: empty,
        model: modelMock(),
        systemPrompt: "sys",
        content: "hi",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("API 未返回内容");

    const thinkingOnly = registryMock([{ type: "thinking", thinking: "…" } as never]);
    await expect(
      completeText({
        registry: thinkingOnly,
        model: modelMock(),
        systemPrompt: "sys",
        content: "hi",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("API 未返回内容");
  });

  it("透传 usage", async () => {
    const registry = registryMock([{ type: "text", text: "ok" }], { totalTokens: 123 });
    const result = await completeText({
      registry,
      model: modelMock(),
      systemPrompt: "sys",
      content: "hi",
      timeoutMs: 1000,
    });
    expect(result.usage.totalTokens).toBe(123);
  });

  it("registry 抛出的错误原样上抛（AbortError 不被改写）", async () => {
    const boom: ModelRegistryLike = {
      find: (): Model<Api> | undefined => undefined,
      complete: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    await expect(
      completeText({
        registry: boom,
        model: modelMock(),
        systemPrompt: "sys",
        content: "hi",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("boom");

    // AbortError 由名字而非类型识别（AI SDK 的取消就是这种形状）
    const abort = new DOMException("aborted", "AbortError");
    const aborted: ModelRegistryLike = {
      find: (): Model<Api> | undefined => undefined,
      complete: vi.fn(async () => {
        throw abort;
      }),
    };
    await expect(
      completeText({
        registry: aborted,
        model: modelMock(),
        systemPrompt: "sys",
        content: "hi",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(abort);
  });
});
