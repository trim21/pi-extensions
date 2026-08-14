/**
 * Tests for the vision-agent extension:
 * - loadVisionConfig: config resolution
 * - resolveImagePaths: path list normalization
 * - callVision: model-registry based vision calls with base64 image content
 * - tool visibility sync on model_select
 * - execute: end-to-end via mocked registry
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  buildPendantMarkdown,
  buildPrompt,
  callVision,
  isMultimodal,
  loadVisionConfig,
  type ModelRegistryLike,
  resolveImagePaths,
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

/** 把 settings.json 写进临时 home，并加载扩展模块 */
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

/** 构造一个最小 Model mock（只带 callVision 用到的字段） */
function modelMock(id = "mimo", maxTokens = 4096): Model<Api> {
  return { id, maxTokens } as Model<Api>;
}

/** 构造 complete 返回指定文本的 registry mock */
function registryMock(
  text = "ok",
  usage?: { totalTokens: number },
): ModelRegistryLike & { complete: Mock } {
  return {
    find: (): Model<Api> | undefined => undefined,
    complete: vi.fn(
      async () =>
        ({
          content: [{ type: "text", text }],
          usage: usage ?? { totalTokens: 42 },
        }) as unknown as AssistantMessage,
    ),
  };
}

/** execute 测试的 ctx 里注入 registry mock */
function visionCtx(registry: unknown) {
  return { cwd: "/cwd", hasUI: false, modelRegistry: registry };
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

describe("buildPendantMarkdown", () => {
  it("summarizes paths, prompt, description and model metadata", () => {
    const markdown = buildPendantMarkdown({
      paths: ["/tmp/cat.png", "/tmp/dog.png"],
      prompt: "每张图各有什么动物？",
      description: "[cat.png, dog.png]\n图1 是猫，图2 是狗\n[模型: mimo, tokens: 42]",
      provider: "axonhub",
      model: "mimo",
    });
    expect(markdown).toContain("## 图片识别");
    expect(markdown).toContain("`cat.png`, `dog.png`");
    expect(markdown).toContain("`axonhub/mimo`");
    expect(markdown).toContain("每张图各有什么动物？");
    expect(markdown).toContain("图1 是猫，图2 是狗");
    expect(markdown).toContain("tokens: 42");
  });

  it("falls back to the full description when it has no body", () => {
    const markdown = buildPendantMarkdown({
      paths: ["/tmp/a.png"],
      prompt: "p",
      description: "[a.png]\n[模型: m, tokens: ?]",
      provider: "axonhub",
      model: "m",
    });
    expect(markdown).toContain("[a.png]");
  });
});

describe("callVision", () => {
  it("sends the image as base64 content and returns the description", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(dir, "cat.png");
      const registry = registryMock("这是一只猫", { totalTokens: 123 });

      const text = await callVision(registry, modelMock("mimo"), [imgPath], buildPrompt());
      expect(text).toContain("这是一只猫");
      expect(text).toContain("mimo");
      expect(text).toContain("cat.png");
      expect(text).toContain("tokens: 123");

      const [, context, options] = registry.complete.mock.calls[0] as unknown as [
        Model<Api>,
        Context,
        { maxTokens: number; signal: AbortSignal },
      ];
      expect(context.systemPrompt).toContain("图像识别助手");
      expect(options.maxTokens).toBe(4096);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const userContent = context.messages[0].content as {
        type: string;
        mimeType?: string;
        data?: string;
      }[];
      expect(userContent[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(userContent[0].data).toMatch(/^iVBOR/); // PNG base64 头
      expect(userContent[1]).toMatchObject({ type: "text" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends multiple image files in a single user message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const img1 = writePng(dir, "a.png");
      const img2 = writePng(dir, "b.png");
      const registry = registryMock("图1 是猫，图2 是狗");

      const text = await callVision(
        registry,
        modelMock("m"),
        [img1, img2],
        buildPrompt(undefined, 2),
      );
      expect(text).toContain("图1 是猫，图2 是狗");
      expect(text).toContain("a.png, b.png");

      const [, context] = registry.complete.mock.calls[0] as unknown as [Model<Api>, Context];
      const userContent = context.messages[0].content as {
        type: string;
        mimeType?: string;
        text?: string;
      }[];
      expect(userContent).toHaveLength(3); // 两张图片 + 文本
      expect(userContent[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(userContent[1]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(userContent[2]).toMatchObject({
        type: "text",
        text: expect.stringContaining("共 2 张图片"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the model's maxTokens when available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(dir, "pic.png");
      const registry = registryMock("ok");
      await callVision(registry, modelMock("m", 8192), [imgPath], "p");
      const options = (
        registry.complete.mock.calls[0] as unknown as [Model<Api>, Context, { maxTokens: number }]
      )[2];
      expect(options.maxTokens).toBe(8192);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported file extensions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const badPath = join(dir, "notes.txt");
      writeFileSync(badPath, "not an image");
      await expect(callVision(registryMock(), modelMock(), [badPath], "p")).rejects.toThrow(
        /不支持的文件格式/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates registry errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(dir, "pic.png");
      const registry = {
        complete: vi.fn(async () => {
          throw new Error("boom");
        }),
      } as never;
      await expect(callVision(registry, modelMock(), [imgPath], "p")).rejects.toThrow(/boom/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws VisionAbortError on abort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(dir, "pic.png");
      const registry = {
        complete: vi.fn(async () => {
          throw new DOMException("aborted", "AbortError");
        }),
      } as never;
      await expect(callVision(registry, modelMock(), [imgPath], "p")).rejects.toBeInstanceOf(
        VisionAbortError,
      );
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

  it("registers even when the provider is missing from models.json (resolved at execute time)", async () => {
    const { visionAgent, tempHome } = await loadVisionAgentWithHome({
      "settings.json": JSON.stringify({ visionConfig: { provider: "nope", model: "m" } }),
    });
    try {
      let tool: { name: string } | undefined;
      visionAgent({
        registerTool: (def: { name: string }) => {
          tool = def;
        },
        on: () => false,
      } as never);

      expect(tool?.name).toBe(TOOL_NAME);
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
      details?: Record<string, unknown>;
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
    const complete = vi.fn(
      async () =>
        ({
          content: [{ type: "text", text: "图中有一只猫" }],
          usage: { totalTokens: 10 },
        }) as unknown as AssistantMessage,
    );
    const registry = { find: () => modelMock("mimo-v2.5"), complete };
    const { tool, tempHome } = await loadToolWithHome({
      "settings.json": JSON.stringify({
        defaultProvider: "axonhub",
        visionConfig: { provider: "axonhub", model: "mimo-v2.5" },
      }),
    });
    const imgDir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(imgDir, "cat.png");
      const onUpdate = vi.fn();
      const result = await tool.execute(
        "id",
        { path: imgPath, prompt: "图中有什么动物？" },
        undefined,
        onUpdate,
        visionCtx(registry),
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("图中有一只猫");
      expect(result.content[0].text).toContain("mimo-v2.5");

      // onUpdate 透传发给视觉模型的 prompt
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate.mock.calls[0][0].content[0].text).toContain("图中有什么动物？");

      // details 携带 prompt 与视觉模型输出
      expect(result.details?.prompt).toBe("图中有什么动物？");
      expect(String(result.details?.output)).toContain("图中有一只猫");
      expect(result.details?.count).toBe(1);

      // pendant markdown 总结关键信息并自动展开
      const pendant = result.details?.pendant as { markdown?: string; expanded?: boolean };
      expect(pendant?.expanded).toBe(true);
      expect(pendant?.markdown).toContain("## 图片识别");
      expect(pendant?.markdown).toContain("cat.png");
      expect(pendant?.markdown).toContain("图中有什么动物？");
      expect(pendant?.markdown).toContain("图中有一只猫");

      // SDK 调用：system 携带默认提示词，user 携带图片 + 自定义 prompt
      expect(complete).toHaveBeenCalledTimes(1);
      const [, context] = complete.mock.calls[0] as unknown as [Model<Api>, Context];
      expect(context.systemPrompt).toContain(VISION_SYSTEM_PROMPT);
      const userContent = context.messages[0].content as { type: string; text?: string }[];
      expect(userContent.at(-1)?.type).toBe("text");
      expect(userContent.at(-1)?.text).toBe("图中有什么动物？");
    } finally {
      rmSync(imgDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("describes multiple images passed as a paths array", async () => {
    const complete = vi.fn(
      async () =>
        ({
          content: [{ type: "text", text: "图1 是猫，图2 是狗" }],
          usage: { totalTokens: 42 },
        }) as unknown as AssistantMessage,
    );
    const registry = { find: () => modelMock("mimo-v2.5"), complete };
    const { tool, tempHome } = await loadToolWithHome({
      "settings.json": JSON.stringify({
        visionConfig: { provider: "axonhub", model: "mimo-v2.5" },
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
        visionCtx(registry),
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("图1 是猫，图2 是狗");

      const [, context] = complete.mock.calls[0] as unknown as [Model<Api>, Context];
      const userContent = context.messages[0].content as { type: string; text?: string }[];
      expect(userContent).toHaveLength(3);
      expect(userContent[0]).toMatchObject({ type: "image" });
      expect(userContent[1]).toMatchObject({ type: "image" });
      expect(userContent[2]).toMatchObject({
        type: "text",
        text: expect.stringContaining("共 2 张图片"),
      });
      expect(userContent[2].text).toContain("每张图各有什么动物？");
    } finally {
      rmSync(imgDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("returns an error when the configured model is not in the registry", async () => {
    const registry = { find: (): Model<Api> | undefined => undefined, complete: vi.fn() };
    const { tool, tempHome } = await loadToolWithHome({
      "settings.json": JSON.stringify({
        visionConfig: { provider: "nope", model: "missing-model" },
      }),
    });
    const imgDir = mkdtempSync(join(tmpdir(), "vision-agent-img-"));
    try {
      const imgPath = writePng(imgDir, "cat.png");
      const result = await tool.execute(
        "id",
        { path: imgPath },
        undefined,
        undefined,
        visionCtx(registry),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("找不到视觉模型");
      expect(registry.complete).not.toHaveBeenCalled();
    } finally {
      rmSync(imgDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("fails fast when path is missing", async () => {
    const registry = { find: () => modelMock(), complete: vi.fn() };
    const { tool, tempHome } = await loadToolWithHome({
      "settings.json": JSON.stringify({
        visionConfig: { provider: "axonhub", model: "mimo-v2.5" },
      }),
    });
    try {
      const result = await tool.execute("id", {}, undefined, undefined, visionCtx(registry));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("path");
      expect(registry.complete).not.toHaveBeenCalled();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
