/**
 * Tests for the vision-agent extension:
 * - loadVisionConfig / resolveProviderConfig: config resolution
 * - resolveImagePaths: path list normalization
 * - callVision: OpenAI-compatible API calls with base64 data URLs
 * - tool visibility sync on model_select
 * - execute: end-to-end via mocked fetch
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPrompt,
  callVision,
  isMultimodal,
  loadVisionConfig,
  normalizeBaseUrl,
  resolveApiKey,
  resolveImagePaths,
  resolveProviderConfig,
  TOOL_NAME,
  VISION_SYSTEM_PROMPT,
  VisionAbortError,
} from "../src/vision-agent.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** PNG 文件头，配合填充字节构造一个可被 sniffMime 识别的假图片 */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function writePng(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([PNG_HEADER, Buffer.from("x".repeat(64))]));
  return path;
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => body,
  } as Response;
}

function withTempFile(content: unknown, fn: (path: string) => void, name = "settings.json") {
  const dir = mkdtempSync(join(tmpdir(), "vision-agent-test-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(content), "utf8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 把 settings.json / models.json 写进临时 home，并加载扩展模块 */
async function loadVisionAgentWithHome(files: Record<string, string>) {
  vi.resetModules();
  const tempHome = mkdtempSync(join(tmpdir(), "vision-home-"));
  const agentDir = join(tempHome, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(agentDir, name), content, "utf8");
  }
  vi.doMock("node:os", async (importOriginal) => {
    const mod = await importOriginal<typeof import("node:os")>();
    return { ...mod, homedir: () => tempHome };
  });
  const { default: visionAgent } = await import("../src/vision-agent.js");
  return { visionAgent, tempHome };
}

describe("loadVisionConfig", () => {
  it("parses visionConfig from settings.json", () => {
    withTempFile({ visionConfig: { provider: "axonhub", model: "mimo-v2.5" } }, (path) => {
      expect(loadVisionConfig(path)).toEqual({ provider: "axonhub", model: "mimo-v2.5" });
    });
  });

  it("falls back to defaultProvider when provider is missing", () => {
    withTempFile({ defaultProvider: "axonhub", visionConfig: { model: "mimo-v2.5" } }, (path) => {
      expect(loadVisionConfig(path)).toEqual({ provider: "axonhub", model: "mimo-v2.5" });
    });
  });

  it("returns undefined when visionConfig is missing", () => {
    withTempFile({ defaultModel: "deepseek-v4-flash" }, (path) => {
      expect(loadVisionConfig(path)).toBeUndefined();
    });
  });

  it("returns undefined on corrupt JSON or missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-test-"));
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, "{ not json", "utf8");
      expect(loadVisionConfig(path)).toBeUndefined();
      expect(loadVisionConfig("/nonexistent/settings.json")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops empty provider and model strings", () => {
    withTempFile({ visionConfig: { provider: "  ", model: "" } }, (path) => {
      expect(loadVisionConfig(path)).toEqual({ provider: undefined, model: undefined });
    });
  });
});

describe("resolveProviderConfig", () => {
  const models = {
    providers: {
      axonhub: {
        baseUrl: "http://192.168.2.18:8090/v1",
        apiKey: "k",
        models: [{ id: "mimo-v2.5", maxTokens: 8192 }],
      },
    },
  };

  it("parses baseUrl, apiKey and the model's maxTokens", () => {
    withTempFile(models, (path) => {
      expect(resolveProviderConfig("axonhub", "mimo-v2.5", path)).toEqual({
        baseUrl: "http://192.168.2.18:8090/v1",
        apiKey: "k",
        maxTokens: 8192,
      });
    });
  });

  it("omits maxTokens when the model is not in the catalog", () => {
    withTempFile(models, (path) => {
      expect(resolveProviderConfig("axonhub", "other-model", path)).toEqual({
        baseUrl: "http://192.168.2.18:8090/v1",
        apiKey: "k",
        maxTokens: undefined,
      });
    });
  });

  it("returns undefined for unknown providers, missing files and corrupt JSON", () => {
    withTempFile(models, (path) => {
      expect(resolveProviderConfig("nope", "m", path)).toBeUndefined();
    });
    expect(resolveProviderConfig("axonhub", "m", "/nonexistent/models.json")).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-test-"));
    try {
      const path = join(dir, "models.json");
      writeFileSync(path, "{ broken", "utf8");
      expect(resolveProviderConfig("axonhub", "m", path)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveApiKey", () => {
  it("resolves $ENV references and passes through plain keys", () => {
    process.env.VISION_TEST_KEY = "secret";
    expect(resolveApiKey("$VISION_TEST_KEY")).toBe("secret");
    expect(resolveApiKey("sk-plain")).toBe("sk-plain");
    expect(resolveApiKey(undefined)).toBeUndefined();
    delete process.env.VISION_TEST_KEY;
  });
});

describe("normalizeBaseUrl", () => {
  it("appends /chat/completions when missing", () => {
    expect(normalizeBaseUrl("http://local/v1")).toBe("http://local/v1/chat/completions");
    expect(normalizeBaseUrl("http://local/v1/chat/completions")).toBe(
      "http://local/v1/chat/completions",
    );
    expect(normalizeBaseUrl("http://local/v1/")).toBe("http://local/v1/chat/completions");
  });
});

describe("resolveImagePaths", () => {
  it("accepts a single path", () => {
    expect(resolveImagePaths({ path: "/tmp/shot.png" })).toEqual(["/tmp/shot.png"]);
  });

  it("accepts an array of paths in order", () => {
    expect(resolveImagePaths({ path: ["/tmp/a.png", "/tmp/b.jpg"] })).toEqual([
      "/tmp/a.png",
      "/tmp/b.jpg",
    ]);
  });

  it("trims and drops empty entries", () => {
    expect(resolveImagePaths({ path: [" /tmp/a.png ", "", "  "] })).toEqual(["/tmp/a.png"]);
  });

  it("returns an empty list when path is missing", () => {
    expect(resolveImagePaths({})).toEqual([]);
    expect(resolveImagePaths({ path: " ".repeat(3) })).toEqual([]);
  });
});

describe("buildPrompt", () => {
  it("uses the caller's prompt when provided", () => {
    expect(buildPrompt("图中验证码是什么？")).toBe("图中验证码是什么？");
    expect(buildPrompt("  逐字翻译图中的文字  ")).toBe("逐字翻译图中的文字");
  });

  it("adds an ordered per-image instruction when multiple images are passed", () => {
    expect(buildPrompt(undefined, 3)).toContain("共 3 张图片");
    expect(buildPrompt(undefined, 3)).toContain("逐张描述");
    expect(buildPrompt("分别翻译每张图的文字", 2)).toContain("共 2 张图片");
    expect(buildPrompt("分别翻译每张图的文字", 2)).toContain("分别翻译每张图的文字");
  });

  it("falls back to the generic description instruction", () => {
    expect(buildPrompt()).toContain("详细描述这张图片");
    expect(buildPrompt(" ".repeat(3))).toContain("详细描述这张图片");
    expect(buildPrompt()).toContain("中文");
  });
});

describe("isMultimodal", () => {
  it("returns true when the model accepts images", () => {
    expect(isMultimodal({ input: ["text", "image"] })).toBe(true);
    expect(isMultimodal({ input: ["text"] })).toBe(false);
    expect(isMultimodal(undefined)).toBe(false);
  });
});

describe("callVision", () => {
  it("sends the image file as a base64 data URL and returns the description", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(dir, "cat.png");
      const fetchMock = vi.fn(async () =>
        okResponse({
          choices: [{ message: { content: "这是一只猫" } }],
          usage: { total_tokens: 123 },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const text = await callVision(
        { baseUrl: "http://local/v1", apiKey: "k", model: "mimo" },
        [imgPath],
        buildPrompt(),
      );
      expect(text).toContain("这是一只猫");
      expect(text).toContain("mimo");
      expect(text).toContain("cat.png");

      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        { headers: Record<string, string>; body: string },
      ];
      expect(url).toBe("http://local/v1/chat/completions");
      expect(init.headers.Authorization).toBe("Bearer k");
      const body = JSON.parse(init.body) as {
        model: string;
        max_tokens: number;
        messages: [
          { role: string; content: string },
          { role: string; content: { type: string; image_url: { url: string } }[] },
        ];
      };
      expect(body.model).toBe("mimo");
      expect(body.max_tokens).toBe(4096);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toContain("图像识别助手");
      expect(body.messages[1].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends multiple image files in a single user message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const img1 = writePng(dir, "a.png");
      const img2 = writePng(dir, "b.png");
      const fetchMock = vi.fn(async () =>
        okResponse({ choices: [{ message: { content: "图1 是猫，图2 是狗" } }] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const text = await callVision(
        { baseUrl: "http://x/v1", model: "m" },
        [img1, img2],
        buildPrompt(undefined, 2),
      );
      expect(text).toContain("图1 是猫，图2 是狗");
      expect(text).toContain("a.png, b.png");

      const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
      const body = JSON.parse(init.body) as {
        messages: [
          { role: string },
          { content: { type: string; image_url?: { url: string }; text?: string }[] },
        ];
      };
      const userContent = body.messages[1].content;
      expect(userContent).toHaveLength(3); // 两张图片 + 文本
      expect(userContent[0].image_url?.url).toMatch(/^data:image\/png;base64,/);
      expect(userContent[1].image_url?.url).toMatch(/^data:image\/png;base64,/);
      expect(userContent[2].text).toContain("共 2 张图片");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the model's maxTokens from the catalog when available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(dir, "pic.png");
      const fetchMock = vi.fn(async () =>
        okResponse({ choices: [{ message: { content: "ok" } }] }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await callVision({ baseUrl: "http://x/v1", model: "m", maxTokens: 8192 }, [imgPath], "p");
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
      expect(JSON.parse(init.body).max_tokens).toBe(8192);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported file extensions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const badPath = join(dir, "notes.txt");
      writeFileSync(badPath, "not an image");
      await expect(
        callVision({ baseUrl: "http://x/v1", model: "m" }, [badPath], "p"),
      ).rejects.toThrow(/不支持的文件格式/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports non-OK API responses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(dir, "pic.png");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () => ({ ok: false, status: 401, text: async () => "unauthorized" }) as Response,
        ),
      );
      await expect(
        callVision({ baseUrl: "http://x/v1", model: "m" }, [imgPath], "p"),
      ).rejects.toThrow(/401/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws VisionAbortError on abort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(dir, "pic.png");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new DOMException("aborted", "AbortError");
        }),
      );
      await expect(
        callVision({ baseUrl: "http://x/v1", model: "m" }, [imgPath], "p"),
      ).rejects.toBeInstanceOf(VisionAbortError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tool registration", () => {
  const CONFIGURED = {
    "settings.json": JSON.stringify({
      visionConfig: { provider: "axonhub", model: "mimo-v2.5" },
    }),
    "models.json": JSON.stringify({
      providers: { axonhub: { baseUrl: "http://local/v1", apiKey: "k", models: [] } },
    }),
  };

  it("registers describe_image when visionConfig is configured", async () => {
    const { visionAgent, tempHome } = await loadVisionAgentWithHome(CONFIGURED);
    try {
      let tool: { name: string; parameters: unknown } | undefined;
      visionAgent({
        registerTool: (def: { name: string; parameters: unknown }) => {
          tool = def;
        },
        on: () => false,
      } as never);

      expect(tool?.name).toBe(TOOL_NAME);
      expect(tool?.parameters).toBeDefined();
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("skips registration when visionConfig is missing", async () => {
    const { visionAgent, tempHome } = await loadVisionAgentWithHome({
      "settings.json": JSON.stringify({}),
    });
    try {
      let tool: { name: string } | undefined;
      visionAgent({
        registerTool: (def: { name: string }) => {
          tool = def;
        },
        on: () => false,
      } as never);

      expect(tool).toBeUndefined();
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("skips registration when the provider is missing from models.json", async () => {
    const { visionAgent, tempHome } = await loadVisionAgentWithHome({
      "settings.json": JSON.stringify({ visionConfig: { provider: "nope", model: "m" } }),
      "models.json": JSON.stringify({ providers: {} }),
    });
    try {
      let tool: { name: string } | undefined;
      visionAgent({
        registerTool: (def: { name: string }) => {
          tool = def;
        },
        on: () => false,
      } as never);

      expect(tool).toBeUndefined();
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("hides describe_image for multimodal models and shows it for text-only models", async () => {
    const { visionAgent, tempHome } = await loadVisionAgentWithHome(CONFIGURED);
    try {
      const events: Record<string, (event: never, ctx: { ui: { notify: () => boolean } }) => void> =
        {};
      let activeTools = ["read", "bash", TOOL_NAME];
      visionAgent({
        registerTool: () => false,
        on: (name: string, handler: never) => {
          events[name] = handler;
        },
        getActiveTools: () => [...activeTools],
        setActiveTools: (tools: string[]) => {
          activeTools = tools;
        },
      } as never);

      const ui = { notify: () => true };
      events.model_select?.({ model: { id: "gpt-4o", input: ["text", "image"] } } as never, { ui });
      expect(activeTools).not.toContain(TOOL_NAME);

      events.model_select?.({ model: { id: "deepseek-v4-flash", input: ["text"] } } as never, {
        ui,
      });
      expect(activeTools).toContain(TOOL_NAME);
    } finally {
      vi.resetModules();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("execute", () => {
  interface Tool {
    execute: (...args: unknown[]) => Promise<{
      content: { type: string; text: string }[];
      isError?: boolean;
    }>;
  }

  async function loadToolWithHome(files: Record<string, string>) {
    const { visionAgent, tempHome } = await loadVisionAgentWithHome(files);
    let tool: Tool | undefined;
    visionAgent({
      registerTool: (def: never) => {
        tool = def;
      },
      on: () => false,
    } as never);
    return { tool: tool!, tempHome };
  }

  it("describes an image via the configured vision model", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        choices: [{ message: { content: "图中有一只猫" } }],
        usage: { total_tokens: 10 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { tool, tempHome } = await loadToolWithHome({
      "settings.json": JSON.stringify({
        defaultProvider: "axonhub",
        visionConfig: { provider: "axonhub", model: "mimo-v2.5" },
      }),
      "models.json": JSON.stringify({
        providers: {
          axonhub: { baseUrl: "http://local/v1", apiKey: "k", models: [{ id: "mimo-v2.5" }] },
        },
      }),
    });
    const imgDir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(imgDir, "cat.png");
      const result = await tool.execute(
        "id",
        { path: imgPath, prompt: "图中有什么动物？" },
        undefined,
        undefined,
        { cwd: "/cwd", hasUI: false },
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("图中有一只猫");
      expect(result.content[0].text).toContain("mimo-v2.5");

      // 请求体：system 携带默认提示词，user 携带自定义 prompt
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
      const body = JSON.parse(init.body) as {
        messages: [
          { role: string; content: string },
          { role: string; content: { text: string }[] },
        ];
      };
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toContain(VISION_SYSTEM_PROMPT);
      expect(body.messages[1].content[1].text).toBe("图中有什么动物？");
    } finally {
      rmSync(imgDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("describes multiple images passed as a paths array", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: "图1 是猫，图2 是狗" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { tool, tempHome } = await loadToolWithHome({
      "settings.json": JSON.stringify({
        visionConfig: { provider: "axonhub", model: "mimo-v2.5" },
      }),
      "models.json": JSON.stringify({
        providers: { axonhub: { baseUrl: "http://local/v1", apiKey: "k", models: [] } },
      }),
    });
    const imgDir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const img1 = writePng(imgDir, "a.png");
      const img2 = writePng(imgDir, "b.png");

      const result = await tool.execute(
        "id",
        { path: [img1, img2], prompt: "每张图各有什么动物？" },
        undefined,
        undefined,
        { cwd: "/cwd", hasUI: false },
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("图1 是猫，图2 是狗");

      const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
      const body = JSON.parse(init.body) as {
        messages: [{ role: string }, { content: { image_url?: { url: string }; text?: string }[] }];
      };
      const userContent = body.messages[1].content;
      expect(userContent).toHaveLength(3);
      expect(userContent[0].image_url?.url).toMatch(/^data:image\/png;base64,/);
      expect(userContent[1].image_url?.url).toMatch(/^data:image\/png;base64,/);
      expect(userContent[2].text).toContain("共 2 张图片");
      expect(userContent[2].text).toContain("每张图各有什么动物？");
    } finally {
      rmSync(imgDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("fails fast when path is missing", async () => {
    const { tool, tempHome } = await loadToolWithHome({
      "settings.json": JSON.stringify({
        visionConfig: { provider: "axonhub", model: "mimo-v2.5" },
      }),
      "models.json": JSON.stringify({
        providers: { axonhub: { baseUrl: "http://local/v1", apiKey: "k", models: [] } },
      }),
    });
    try {
      const result = await tool.execute("id", {}, undefined, undefined, {
        cwd: "/cwd",
        hasUI: false,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("path");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
