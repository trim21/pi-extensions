/**
 * Tests for the openai-cost provider:
 * - config: ~/.pi/agent/openai-cost.json parsing
 * - cost: usage.cost extraction, SSE scan, stream wrap
 * - provider: static models and remote /models mapping
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadOpenaiCostConfig } from "../src/openai-cost/config.js";
import {
  applyReportedCost,
  costFromSseLine,
  createReportedCostCapture,
  extractReportedCost,
  wrapStreamWithReportedCost,
} from "../src/openai-cost/cost.js";
import {
  createOpenaiCostProvider,
  fetchRemoteModels,
  mapRemoteModels,
  toPiModel,
} from "../src/openai-cost/provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function tempFile(content: string, name = "openai-cost.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "openai-cost-test-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

function removeParent(path: string): void {
  rmSync(join(path, ".."), { recursive: true, force: true });
}

function sseFetch(body: string): typeof fetch {
  return () =>
    Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
}

function jsonFetch(data: unknown): typeof fetch {
  return () => Promise.resolve(Response.json(data));
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const sampleConfig = {
  id: "gateway",
  name: "Gateway",
  baseUrl: "https://api.example.com/v1",
  apiKeyEnv: "GATEWAY_KEY",
};

function assistantMessage(costTotal = 1.5): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "openai-completions",
    provider: "openai-cost",
    model: "m",
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 1, output: 0.5, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("loadOpenaiCostConfig", () => {
  it("parses required fields and model defaults", async () => {
    const path = tempFile(
      JSON.stringify({
        baseUrl: "https://api.example.com/v1/",
        models: [{ id: "my-model" }],
      }),
    );
    try {
      expect(await loadOpenaiCostConfig(path)).toEqual({
        id: "openai-cost",
        name: "OpenAI Cost",
        baseUrl: "https://api.example.com/v1",
        apiKeyEnv: "OPENAI_COST_API_KEY",
        models: [
          {
            id: "my-model",
            name: "my-model",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      });
    } finally {
      removeParent(path);
    }
  });

  it("keeps explicit model fields", async () => {
    const path = tempFile(
      JSON.stringify({
        id: "gw",
        name: "GW",
        baseUrl: "https://gw.example/v1",
        apiKeyEnv: "GW_KEY",
        models: [
          {
            id: "vision",
            name: "Vision",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 16384,
            baseUrl: "https://gw.example/vision/v1",
          },
        ],
      }),
    );
    try {
      expect(await loadOpenaiCostConfig(path)).toEqual({
        id: "gw",
        name: "GW",
        baseUrl: "https://gw.example/v1",
        apiKeyEnv: "GW_KEY",
        models: [
          {
            id: "vision",
            name: "Vision",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 16384,
            baseUrl: "https://gw.example/vision/v1",
          },
        ],
      });
    } finally {
      removeParent(path);
    }
  });

  it("treats empty models as dynamic catalog", async () => {
    const path = tempFile(JSON.stringify({ baseUrl: "https://api.example.com/v1", models: [] }));
    try {
      expect(await loadOpenaiCostConfig(path)).toEqual({
        id: "openai-cost",
        name: "OpenAI Cost",
        baseUrl: "https://api.example.com/v1",
        apiKeyEnv: "OPENAI_COST_API_KEY",
        models: undefined,
      });
    } finally {
      removeParent(path);
    }
  });

  it("returns undefined for missing file, corrupt JSON, or invalid shape", async () => {
    expect(await loadOpenaiCostConfig("/nonexistent/openai-cost.json")).toBeUndefined();
    const corrupt = tempFile("{ not json");
    const invalid = tempFile(JSON.stringify({ name: "no-url" }));
    try {
      expect(await loadOpenaiCostConfig(corrupt)).toBeUndefined();
      expect(await loadOpenaiCostConfig(invalid)).toBeUndefined();
    } finally {
      removeParent(corrupt);
      removeParent(invalid);
    }
  });
});

describe("extractReportedCost", () => {
  it("reads usage.cost as a number", () => {
    expect(extractReportedCost({ usage: { cost: 0.12 } })).toBe(0.12);
  });

  it("reads usage.cost.total", () => {
    expect(extractReportedCost({ usage: { cost: { total: 0.34 } } })).toBe(0.34);
  });

  it("reads choice.usage.cost", () => {
    expect(extractReportedCost({ choices: [{ usage: { cost: 0.56 } }] })).toBe(0.56);
  });

  it("returns undefined without a numeric cost", () => {
    expect(extractReportedCost({ usage: { prompt_tokens: 1 } })).toBeUndefined();
    expect(extractReportedCost({ usage: { cost: "0.1" } })).toBeUndefined();
    expect(extractReportedCost(null)).toBeUndefined();
  });
});

describe("costFromSseLine", () => {
  it("parses the last data line cost and ignores [DONE]", () => {
    expect(costFromSseLine('data: {"usage":{"cost":0.2}}')).toBe(0.2);
    expect(costFromSseLine("data: [DONE]")).toBeUndefined();
    expect(costFromSseLine("event: ping")).toBeUndefined();
  });
});

describe("createReportedCostCapture", () => {
  it("captures usage.cost from a chat completions SSE body without consuming the SDK copy", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":1,"cost":0.77}}',
      "data: [DONE]",
      "",
    ].join("\n");
    const capture = createReportedCostCapture(sseFetch(sse));
    const response = await capture.fetch("https://api.example.com/v1/chat/completions");
    expect(await response.text()).toContain("hi");
    expect(await capture.wait()).toBe(0.77);
  });

  it("does not scan non-stream model list responses", async () => {
    const capture = createReportedCostCapture(jsonFetch({ data: [] }));
    await capture.fetch("https://api.example.com/v1/models");
    expect(await capture.wait()).toBeUndefined();
  });
});

describe("wrapStreamWithReportedCost", () => {
  it("overrides finalized cost.total and zeros the breakdown", async () => {
    const inner = createAssistantMessageEventStream();
    const wrapped = wrapStreamWithReportedCost(inner, () => Promise.resolve(0.42));
    const message = assistantMessage(9);
    inner.push({ type: "start", partial: message });
    inner.push({ type: "done", reason: "stop", message });
    inner.end();
    const result = await wrapped.result();
    expect(result.usage.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.42,
    });
  });

  it("keeps calculateCost when the API omitted usage.cost", async () => {
    const inner = createAssistantMessageEventStream();
    const wrapped = wrapStreamWithReportedCost(inner, () => Promise.resolve(undefined));
    const message = assistantMessage(1.5);
    inner.push({ type: "done", reason: "stop", message });
    inner.end();
    const result = await wrapped.result();
    expect(result.usage.cost.total).toBe(1.5);
  });
});

describe("applyReportedCost", () => {
  it("writes total and clears component costs", () => {
    const usage = assistantMessage().usage;
    applyReportedCost(usage, 0);
    expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });
});

describe("toPiModel / mapRemoteModels", () => {
  it("maps config models onto openai-completions", () => {
    expect(
      toPiModel(sampleConfig, {
        id: "m",
        name: "M",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 100,
        maxTokens: 10,
      }),
    ).toMatchObject({
      id: "m",
      api: "openai-completions",
      provider: "gateway",
      baseUrl: "https://api.example.com/v1",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("maps /models payloads with defaults", () => {
    const models = mapRemoteModels(sampleConfig, {
      data: [
        { id: "a", name: "A", context_window: 32000, max_tokens: 4096 },
        { id: "  ", name: "skip" },
        { id: "b" },
      ],
    });
    expect(models.map((model) => model.id)).toEqual(["a", "b"]);
    expect(models[0]).toMatchObject({
      name: "A",
      contextWindow: 32000,
      maxTokens: 4096,
      input: ["text"],
    });
    expect(models[1]).toMatchObject({ name: "b", contextWindow: 128000, maxTokens: 8192 });
  });
});

describe("fetchRemoteModels", () => {
  it("GETs /models with bearer auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      expect(fetchInputUrl(input)).toBe("https://api.example.com/v1/models");
      return Promise.resolve(Response.json({ data: [{ id: "remote" }] }));
    });
    const models = await fetchRemoteModels(sampleConfig, { apiKey: "sk-test", fetch: fetchImpl });
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("remote");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { Accept: "application/json", Authorization: "Bearer sk-test" },
    });
  });

  it("throws on non-OK /models", async () => {
    await expect(
      fetchRemoteModels(sampleConfig, {
        fetch: async () => new Response("nope", { status: 401 }),
      }),
    ).rejects.toThrow(/401/);
  });
});

describe("createOpenaiCostProvider", () => {
  const model: Model<"openai-completions"> = {
    id: "m",
    name: "M",
    api: "openai-completions",
    provider: "gateway",
    baseUrl: sampleConfig.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
  const context: Context = { messages: [] };

  it("exposes static models without refresh", () => {
    const provider = createOpenaiCostProvider({
      ...sampleConfig,
      models: [
        {
          id: "static",
          name: "Static",
          reasoning: false,
          input: ["text"],
          contextWindow: 1,
          maxTokens: 1,
        },
      ],
    });
    expect(provider.id).toBe("gateway");
    expect(provider.getModels().map((item) => item.id)).toEqual(["static"]);
  });

  it("injects fetch so stream done events use usage.cost", async () => {
    const innerFetch = sseFetch(['data: {"usage":{"cost":0.99}}', "data: [DONE]", ""].join("\n"));
    const api: ProviderStreams = {
      stream: (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          const message = assistantMessage(3);
          stream.push({ type: "start", partial: message });
          await options?.fetch?.("https://api.example.com/v1/chat/completions");
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        })();
        return stream;
      },
      streamSimple: (_model, _context, options) => api.stream(_model, _context, options),
    };
    const provider = createOpenaiCostProvider(sampleConfig, { api, fetch: innerFetch });
    const result = await provider
      .stream(model, context, { apiKey: "k", fetch: innerFetch })
      .result();
    expect(result.usage.cost.total).toBe(0.99);
  });
});
