/**
 * Tests for the session-name extension:
 * - loadSessionNameConfig: config resolution
 * - sanitizeName: name cleaning
 * - extractFirstUserPrompt: prompt text selection (fresh vs resumed)
 * - callNamer / generateSessionName: model-registry based naming calls
 * - extension behavior: config-gated naming, skip rules, stale-pi safety
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  buildNamerPrompt,
  callNamer,
  DEFAULT_MAX_LENGTH,
  extractFirstUserPrompt,
  generateSessionName,
  loadSessionNameConfig,
  type ModelRegistryLike,
  NAMER_MAX_TOKENS,
  sanitizeName,
} from "../src/session-name.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function withTempFile(content: unknown, fn: (path: string) => void, name = "settings.json") {
  const dir = mkdtempSync(join(tmpdir(), "session-name-test-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(content), "utf8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadSessionNameConfig", () => {
  it("parses sessionName from settings.json", () => {
    withTempFile(
      { sessionName: { provider: "axonhub", model: "deepseek-v4-flash", maxLength: 20 } },
      (path) => {
        expect(loadSessionNameConfig(path)).toEqual({
          provider: "axonhub",
          model: "deepseek-v4-flash",
          maxLength: 20,
        });
      },
    );
  });

  it("falls back to defaultProvider when provider is missing", () => {
    withTempFile({ defaultProvider: "axonhub", sessionName: { model: "m" } }, (path) => {
      expect(loadSessionNameConfig(path)).toEqual({
        provider: "axonhub",
        model: "m",
        maxLength: undefined,
      });
    });
  });

  it("returns undefined when sessionName is missing", () => {
    withTempFile({ defaultModel: "deepseek-v4-flash" }, (path) => {
      expect(loadSessionNameConfig(path)).toBeUndefined();
    });
  });

  it("returns undefined on corrupt JSON or missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-name-test-"));
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, "{ not json", "utf8");
      expect(loadSessionNameConfig(path)).toBeUndefined();
      expect(loadSessionNameConfig("/nonexistent/settings.json")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-name-test-"));
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, '{ "sessionName": { "model": "m", }', "utf8");
      expect(loadSessionNameConfig(path)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops empty provider/model strings and invalid maxLength", () => {
    withTempFile({ sessionName: { provider: "  ", model: "", maxLength: -5 } }, (path) => {
      expect(loadSessionNameConfig(path)).toEqual({
        provider: undefined,
        model: undefined,
        maxLength: undefined,
      });
    });
  });
});

describe("sanitizeName", () => {
  it("collapses whitespace and trims", () => {
    expect(sanitizeName("  a   b\n c ")).toBe("a b c");
  });

  it("returns undefined for empty input", () => {
    expect(sanitizeName("")).toBeUndefined();
    expect(sanitizeName(" ".repeat(3))).toBeUndefined();
  });

  it("keeps short names and truncates long ones with an ellipsis", () => {
    expect(sanitizeName("abcde", 5)).toBe("abcde");
    expect(sanitizeName("一二三四五六七八九十", 5)).toBe("一二三四…");
  });
});

describe("extractFirstUserPrompt", () => {
  it("uses the current prompt for a fresh session (empty branch)", () => {
    expect(extractFirstUserPrompt([], "  修复 bug  ")).toBe("修复 bug");
    expect(extractFirstUserPrompt([], "  ")).toBeUndefined();
  });

  it("finds the first user message when resuming", () => {
    const branch = [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "第一条消息" }] },
      },
      { type: "message", message: { role: "assistant", content: "回复" } },
      { type: "message", message: { role: "user", content: "第二条" } },
    ];
    expect(extractFirstUserPrompt(branch, "当前消息")).toBe("第一条消息");
  });

  it("handles string content and skips non-message entries", () => {
    const branch = [
      { type: "model_change", provider: "p", modelId: "m" },
      { type: "message", message: { role: "user", content: "纯文本" } },
    ];
    expect(extractFirstUserPrompt(branch, "当前")).toBe("纯文本");
  });

  it("falls back to the current prompt when history has no user message", () => {
    const branch = [{ type: "compaction", summary: "..." }];
    expect(extractFirstUserPrompt(branch, "当前消息")).toBe("当前消息");
  });
});

describe("buildNamerPrompt", () => {
  it("instructs a short name with the max length", () => {
    const prompt = buildNamerPrompt(20);
    expect(prompt).toContain("会话命名助手");
    expect(prompt).toContain("20 个字符");
  });
});

/** callNamer / generateSessionName 测试用的 registry mock */
function namerRegistry(
  content: unknown[] = [{ type: "text", text: "修复登录bug" }],
): ModelRegistryLike {
  return {
    find: () => ({}) as Model<Api>,
    complete: vi.fn(async () => ({ content }) as unknown as AssistantMessage),
  };
}

describe("callNamer", () => {
  it("calls registry.complete with the naming prompt and returns the model text", async () => {
    const registry = namerRegistry();
    const text = await callNamer(registry, {} as Model<Api>, "帮我修复登录页面的 bug", 20);
    expect(text).toBe("修复登录bug");

    const [, context, options] = (registry.complete as Mock).mock.calls[0] as unknown as [
      Model<Api>,
      Context,
      { maxTokens: number; signal: AbortSignal },
    ];
    expect(context.systemPrompt).toContain("会话命名助手");
    expect(context.messages[0].content).toBe("帮我修复登录页面的 bug");
    expect(options.maxTokens).toBe(NAMER_MAX_TOKENS);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports empty model output", async () => {
    const registry = namerRegistry([]);
    await expect(callNamer(registry as never, {} as Model<Api>, "p", 20)).rejects.toThrow(
      /未返回内容/,
    );
  });

  it("ignores thinking blocks and only uses text content", async () => {
    // 推理模型的 thinking 块是思考过程而非最终答案，不能当作会话名
    const registry = namerRegistry([
      {
        type: "thinking",
        thinking: '我们需要理解用户的要求。用户写道："你是一个会话命名助手。…"',
      },
      { type: "text", text: "修复登录bug" },
    ]);
    const text = await callNamer(registry, {} as Model<Api>, "p", 20);
    expect(text).toBe("修复登录bug");
  });
});

describe("generateSessionName", () => {
  it("uses the model output when configured", async () => {
    const registry = namerRegistry();
    const name = await generateSessionName(
      "帮我修复登录页面的 bug",
      { provider: "axonhub", model: "m" },
      { registry },
    );
    expect(name).toBe("修复登录bug");
  });

  it("returns undefined when the model call fails", async () => {
    const registry = {
      find: () => ({}) as Model<Api>,
      complete: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const onModelFallback = vi.fn();
    const name = await generateSessionName(
      "帮我修复登录页面的 bug",
      { provider: "axonhub", model: "m" },
      { registry, onModelFallback },
    );
    expect(name).toBeUndefined();
    expect(onModelFallback).toHaveBeenCalledWith("model-error");
  });

  it("returns undefined when the model is not in the registry", async () => {
    const registry = { find: (): Model<Api> | undefined => undefined, complete: vi.fn() };
    const onModelFallback = vi.fn();
    const name = await generateSessionName(
      "修复 bug",
      { provider: "nope", model: "m" },
      { registry, onModelFallback },
    );
    expect(name).toBeUndefined();
    expect(onModelFallback).toHaveBeenCalledWith("model-unavailable");
  });

  it("reports the model fallback reason", async () => {
    const errorRegistry = {
      find: () => ({}) as Model<Api>,
      complete: vi.fn(async () => {
        throw new Error("timeout");
      }),
    };
    const onError = vi.fn();
    const name = await generateSessionName(
      "修复 bug",
      { model: "m" },
      { registry: errorRegistry, onModelFallback: onError },
    );
    expect(name).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("model-error");

    const missingRegistry = { find: (): Model<Api> | undefined => undefined, complete: vi.fn() };
    const onMissing = vi.fn();
    await generateSessionName(
      "修复 bug",
      { model: "m" },
      { registry: missingRegistry, onModelFallback: onMissing },
    );
    expect(onMissing).toHaveBeenCalledWith("model-unavailable");

    const onSuccess = vi.fn();
    await generateSessionName(
      "修复 bug",
      { model: "m" },
      { registry: namerRegistry(), onModelFallback: onSuccess },
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("returns undefined when no model is configured", async () => {
    const name = await generateSessionName("修复 bug\n详情", undefined);
    expect(name).toBeUndefined();
  });

  it("truncates overly long model output", async () => {
    const registry = namerRegistry([{ type: "text", text: "这是一个非常非常非常长的名字" }]);
    const name = await generateSessionName("p", { model: "m", maxLength: 6 }, { registry });
    expect(name).toBe("这是一个非…");
  });
});

/** 把 settings.json 写进临时 home，并加载扩展模块 */
async function loadExtensionWithHome(files: Record<string, string>) {
  vi.resetModules();
  const tempHome = mkdtempSync(join(tmpdir(), "session-name-home-"));
  const agentDir = join(tempHome, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(agentDir, name), content, "utf8");
  }
  vi.doMock("node:os", async (importOriginal) => {
    const mod = await importOriginal<typeof import("node:os")>();
    return { ...mod, homedir: () => tempHome };
  });
  const { default: sessionNameExtension } = await import("../src/session-name.js");
  return { sessionNameExtension, tempHome };
}

interface PiMock {
  on: (name: string, handler: never) => void;
  getSessionName: () => string | undefined;
  setSessionName: (name: string) => void;
}

function createPi(overrides: Partial<PiMock> = {}) {
  const handlers: Record<string, (event: never, ctx: never) => void> = {};
  const setSessionName = vi.fn();
  const pi: PiMock = {
    on: (name, handler) => {
      handlers[name] = handler;
    },
    getSessionName: () => {
      return; // 默认无名
    },
    setSessionName: setSessionName,
    ...overrides,
  };
  return { pi, handlers, setSessionName };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: false,
    ui: { notify: vi.fn() },
    sessionManager: { getBranch: () => [] },
    ...overrides,
  };
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("extension behavior", () => {
  it("does not name the session when sessionName is not configured", async () => {
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({});
    try {
      const notify = vi.fn();
      const { pi, handlers, setSessionName } = createPi();
      sessionNameExtension(pi as never);
      handlers.before_agent_start?.(
        { prompt: "帮我修复登录页面的 bug" } as never,
        ctx({ hasUI: true, ui: { notify } }) as never,
      );
      await delay();
      expect(setSessionName).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("sessionName"), "warning");
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("does not notify a warning when sessionName is configured", async () => {
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({
      "settings.json": JSON.stringify({ sessionName: { model: "m" } }),
    });
    try {
      const notify = vi.fn();
      const complete = vi.fn(async () => ({
        content: [{ type: "text", text: "修复登录bug" }],
      }));
      const { pi, handlers, setSessionName } = createPi();
      sessionNameExtension(pi as never);
      handlers.before_agent_start?.(
        { prompt: "帮我修复登录页面的 bug" } as never,
        ctx({
          hasUI: true,
          ui: { notify },
          modelRegistry: { find: () => ({}) as Model<Api>, complete },
        }) as never,
      );
      await vi.waitFor(() => expect(setSessionName).toHaveBeenCalled());
      expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("sessionName"), "warning");
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("uses the configured naming model when available", async () => {
    const complete = vi.fn(async () => ({
      content: [{ type: "text", text: "修复登录bug" }],
    }));
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({
      "settings.json": JSON.stringify({ sessionName: { provider: "axonhub", model: "m" } }),
    });
    try {
      const { pi, handlers, setSessionName } = createPi();
      sessionNameExtension(pi as never);
      const registry = { find: () => ({}) as Model<Api>, complete };
      handlers.before_agent_start?.(
        { prompt: "帮我修复登录页面的 bug" } as never,
        ctx({ modelRegistry: registry }) as never,
      );
      await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("修复登录bug"));
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("skips when the session already has a name", async () => {
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({});
    try {
      const { pi, handlers, setSessionName } = createPi({ getSessionName: () => "Existing" });
      sessionNameExtension(pi as never);
      handlers.before_agent_start?.({ prompt: "帮我修复 bug" } as never, ctx() as never);
      await delay();
      expect(setSessionName).not.toHaveBeenCalled();
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("names from the first user message when resuming an unnamed session", async () => {
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({
      "settings.json": JSON.stringify({ sessionName: { model: "m" } }),
    });
    try {
      const complete = vi.fn(async () => ({
        content: [{ type: "text", text: "历史第一条消息" }],
      }));
      const { pi, handlers, setSessionName } = createPi();
      sessionNameExtension(pi as never);
      const branch = [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "历史第一条消息" }] },
        },
      ];
      handlers.before_agent_start?.(
        { prompt: "当前 prompt" } as never,
        ctx({
          sessionManager: { getBranch: () => branch },
          modelRegistry: { find: () => ({}) as Model<Api>, complete },
        }) as never,
      );
      await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("历史第一条消息"));
      // 喂给命名模型的是历史第一条 user 消息，而不是当前 prompt
      const [, context] = complete.mock.calls[0] as unknown as [Model<Api>, Context];
      expect(context.messages[0].content).toBe("历史第一条消息");
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("skips empty prompts", async () => {
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({});
    try {
      const { pi, handlers, setSessionName } = createPi();
      sessionNameExtension(pi as never);
      handlers.before_agent_start?.({ prompt: " ".repeat(3) } as never, ctx() as never);
      await delay();
      expect(setSessionName).not.toHaveBeenCalled();
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("notifies when the session is named in a UI session", async () => {
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({
      "settings.json": JSON.stringify({ sessionName: { model: "m" } }),
    });
    try {
      const notify = vi.fn();
      const { pi, handlers } = createPi();
      sessionNameExtension(pi as never);
      handlers.before_agent_start?.(
        { prompt: "修复 bug" } as never,
        ctx({
          hasUI: true,
          ui: { notify },
          modelRegistry: {
            find: () => ({}) as Model<Api>,
            complete: vi.fn(async () => ({ content: [{ type: "text", text: "修复 bug" }] })),
          },
        }) as never,
      );
      await vi.waitFor(() => expect(notify).toHaveBeenCalled());
      expect(String(notify.mock.calls[0][0])).toContain("修复 bug");
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("notifies a warning when the naming model call fails", async () => {
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({
      "settings.json": JSON.stringify({ sessionName: { provider: "axonhub", model: "m" } }),
    });
    try {
      const notify = vi.fn();
      const { pi, handlers, setSessionName } = createPi();
      sessionNameExtension(pi as never);
      const registry = {
        find: () => ({}) as Model<Api>,
        complete: vi.fn(async () => {
          throw new Error("timeout");
        }),
      };
      handlers.before_agent_start?.(
        { prompt: "帮我修复 bug" } as never,
        ctx({ hasUI: true, ui: { notify }, modelRegistry: registry }) as never,
      );
      await delay();
      expect(setSessionName).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("命名模型调用失败"), "warning");
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("notifies a warning when the naming model is unavailable", async () => {
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({
      "settings.json": JSON.stringify({ sessionName: { provider: "nope", model: "m" } }),
    });
    try {
      const notify = vi.fn();
      const { pi, handlers, setSessionName } = createPi();
      sessionNameExtension(pi as never);
      const registry = { find: (): Model<Api> | undefined => undefined, complete: vi.fn() };
      handlers.before_agent_start?.(
        { prompt: "帮我修复 bug" } as never,
        ctx({ hasUI: true, ui: { notify }, modelRegistry: registry }) as never,
      );
      await delay();
      expect(setSessionName).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("命名模型不可用"), "warning");
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("swallows stale-pi errors after a session switch", async () => {
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({
      "settings.json": JSON.stringify({ sessionName: { model: "m" } }),
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const { pi, handlers } = createPi({
        setSessionName: () => {
          throw new Error("This extension ctx is stale after session replacement");
        },
      });
      sessionNameExtension(pi as never);
      handlers.before_agent_start?.(
        { prompt: "帮我修复 bug" } as never,
        ctx({
          modelRegistry: {
            find: () => ({}) as Model<Api>,
            complete: vi.fn(async () => ({ content: [{ type: "text", text: "修复 bug" }] })),
          },
        }) as never,
      );
      await delay();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", listener);
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("uses DEFAULT_MAX_LENGTH when maxLength is not configured", async () => {
    // 未配 maxLength 时，超长模型输出按默认长度截断
    const { sessionNameExtension, tempHome } = await loadExtensionWithHome({
      "settings.json": JSON.stringify({ sessionName: { model: "m" } }),
    });
    try {
      const { pi, handlers, setSessionName } = createPi();
      sessionNameExtension(pi as never);
      handlers.before_agent_start?.(
        { prompt: "帮我修复 bug" } as never,
        ctx({
          modelRegistry: {
            find: () => ({}) as Model<Api>,
            complete: vi.fn(async () => ({
              content: [{ type: "text", text: "啊".repeat(100) }],
            })),
          },
        }) as never,
      );
      await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledTimes(1));
      const name = setSessionName.mock.calls[0][0];
      expect(name.length).toBeLessThanOrEqual(DEFAULT_MAX_LENGTH);
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
