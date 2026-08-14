/**
 * vision-agent —— 视觉代理扩展
 *
 * 让非多模态主模型（如 DeepSeek）通过 describe_image 工具完成图片识别：
 * 图片文件直接以 base64 交给 pi 的 AI SDK（ctx.modelRegistry.complete），
 * 由视觉模型完成识别 —— 不经过任何 read 工具或中间 agent，识别过程对主
 * 模型完全透明。支持一次传入多张图片（path 数组），user 消息里同时携带
 * 全部图片，由模型按顺序逐张描述。
 *
 * 配置不单独维护：视觉模型来自 ~/.pi/agent/settings.json 的 `visionConfig`
 * （\{ provider, model \}，provider 缺省时回退到 defaultProvider），provider
 * 的 baseUrl / apiKey 由 pi 的模型注册表解析（models.json），认证、代理、
 * 网络全部复用 pi 自身配置。
 *
 * 使用前提：本扩展与 pi-vlm-proxy 都注册同名 describe_image 工具，
 * 启用前请先从 ~/.pi/agent/settings.json 的 packages 中移除 pi-vlm-proxy，
 * 否则工具注册会冲突。
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

import {
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  contentText,
  type Context,
  type ImageContent,
  type Model,
  type TextContent,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type ToolPendant } from "./lib/pendant.js";

// ── constants ────────────────────────────────────────────────────────────────

export const TOOL_NAME = "describe_image";
/** ~/.pi/agent/settings.json：visionConfig（provider + model）所在文件 */
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
/** 单张图片体积上限：base64 后约 1.34 倍，再整体塞进请求 body，需要留出内存余量 */
export const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
/** 单次视觉请求的默认超时。ctx.signal 在 agent 空闲时为 undefined，不能只依赖它 */
export const REQUEST_TIMEOUT_MS = 300_000;
/** 未在模型元数据中找到 maxTokens 时的输出上限 */
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * 视觉模型的默认 system prompt。agent 通过 describe_image 的 `prompt`
 * 参数追加具体要求（如「图中验证码是什么」），未传时用通用的详细描述指令。
 */
export const VISION_SYSTEM_PROMPT = [
  "你是一个图像识别助手。根据图片内容准确、完整地回答用户的问题。",
  "涉及可见文字、代码、命令、数字时逐字转述，说明颜色、布局与位置关系。",
  "默认使用中文回答。",
].join("\n");

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MIME_FROM_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** 用户主动取消（区别于真正的失败，调用方不该把它当错误汇报） */
export class VisionAbortError extends Error {
  constructor(message = "已取消") {
    super(message);
    this.name = "VisionAbortError";
  }
}

// ── types ────────────────────────────────────────────────────────────────────

export interface VisionConfigSettings {
  provider?: string;
  model?: string;
}

/**
 * 视觉识别所需的模型注册表操作：扩展传 ctx.modelRegistry，测试传 mock。
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

// ── 纯函数（可测试）──────────────────────────────────────────────────────────

/** 把 path（单个或数组）规整成非空字符串列表，顺序不变 */
export function resolveImagePaths(params: { path?: string | string[] }): string[] {
  return toTrimmedList(params.path);
}

function toTrimmedList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * 读取 ~/.pi/agent/settings.json 的 visionConfig。
 * provider 缺省时回退到 defaultProvider；文件缺失 / JSON 损坏 / 无 visionConfig
 * 时返回 undefined，由调用方决定如何提示。
 */
export function loadVisionConfig(settingsPath = SETTINGS_PATH): VisionConfigSettings | undefined {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const settings = parsed as Record<string, unknown>;
    const vc = settings.visionConfig;
    if (!vc || typeof vc !== "object" || Array.isArray(vc)) return undefined;
    const config = vc as Record<string, unknown>;
    const provider =
      typeof config.provider === "string" ? config.provider.trim() || undefined : undefined;
    const defaultProvider =
      typeof settings.defaultProvider === "string"
        ? settings.defaultProvider.trim() || undefined
        : undefined;
    return {
      provider: provider ?? defaultProvider,
      model: typeof config.model === "string" ? config.model.trim() || undefined : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * 拼装发给视觉模型的用户指令：agent 传了具体 prompt 就用它，
 * 否则退化为通用的详细描述指令。多图时追加「按顺序逐张描述」的要求。
 */
export function buildPrompt(customPrompt?: string, imageCount = 1): string {
  const instruction =
    customPrompt?.trim() ||
    "详细描述这张图片的全部内容，包括所有可见文字、代码、命令、菜单、按钮、数字、图表，以及颜色、布局和位置关系。直接用中文描述。";
  if (imageCount > 1) {
    return `共 ${imageCount} 张图片，请按顺序逐张描述，说明每张图片分别的内容。${instruction}`;
  }
  return instruction;
}

/** 只依赖 input 字段判断模型是否多模态，不绑定 pi 内部类型 */
export function isMultimodal(model: { input?: readonly string[] } | undefined): boolean {
  return !!model && Array.isArray(model.input) && model.input.includes("image");
}

/**
 * 把识别结果整理成 pendant 渲染用的 markdown。
 * description 格式为 callVision 拼装的 `[label]\n<正文>\n[模型: ...]`，
 * 第一行是图片标签、最后一行是模型/ token 元信息，中间是视觉模型输出正文。
 */
export function buildPendantMarkdown(params: {
  paths: string[];
  prompt: string;
  description: string;
  provider: string;
  model: string;
}): string {
  const lines = params.description.split("\n");
  const labels = lines[0]?.trim().replaceAll(/^\[|\]$/g, "") ?? "";
  const footer = lines.at(-1)?.trim() ?? "";
  const body = lines.slice(1, -1).join("\n").trim();
  const files = params.paths.map((p) => `\`${basename(p)}\``).join(", ");
  return [
    "## 图片识别",
    "",
    `**图片**: ${files || labels}`,
    `**视觉模型**: \`${params.provider}/${params.model}\``,
    `**Prompt**: ${params.prompt}`,
    "",
    "### 识别结果",
    "",
    body || params.description,
    footer ? `\n---\n${footer}` : "",
  ]
    .join("\n")
    .trim();
}

// ── 图片加载与 API 调用 ─────────────────────────────────────────────────────

/** 按文件头识别真实图片类型，识别不出返回 undefined */
function sniffMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return undefined;
}

/** 读取图片文件 → base64 + mimeType + 展示名 */
function loadImageBytes(path: string): { base64: string; mimeType: string; label: string } {
  const ext = extname(path).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) throw new Error(`不支持的文件格式: ${ext || "(无扩展名)"}`);

  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw new Error(
      `无法读取文件 ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!stat.isFile()) throw new Error(`不是普通文件: ${path}`);
  if (stat.size === 0) throw new Error(`文件为空: ${path}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，上限 10MB`);
  }

  const buffer = readFileSync(path);
  // 扩展名可能骗人（.png 里装的是 JPEG），以文件头为准
  const mimeType = sniffMime(buffer) || MIME_FROM_EXT[ext] || "image/png";
  return { base64: buffer.toString("base64"), mimeType, label: basename(path) };
}

/** 合并调用方 signal 与本地超时；调用方未传时仍然有超时兜底 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 通过模型注册表调用视觉模型识别图片。所有图片文件直接以 base64 放进
 * 同一个 user 消息 —— 不需要模型或 agent 先读取图片文件。走 pi 的 AI SDK
 * （modelRegistry.complete），复用 provider 解析与 thinking/重试/usage 等
 * 基础设施，不手写 HTTP 请求。
 *
 * @returns 视觉模型返回的文字描述（含图片标签与 token 元信息）
 */
export async function callVision(
  registry: ModelRegistryLike,
  model: Model<Api>,
  paths: string[],
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const loaded = paths.map((p) => loadImageBytes(p));
  const content: (ImageContent | TextContent)[] = [
    ...loaded.map(
      ({ base64, mimeType }) => ({ type: "image", data: base64, mimeType }) satisfies ImageContent,
    ),
    { type: "text", text: prompt } satisfies TextContent,
  ];
  let result: AssistantMessage;
  try {
    result = await registry.complete(
      model,
      {
        systemPrompt: VISION_SYSTEM_PROMPT,
        messages: [{ role: "user", content, timestamp: Date.now() }],
      },
      {
        maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    // 用户主动取消（signal abort）不是失败，转成 VisionAbortError 由调用方处理
    if (error instanceof Error && error.name === "AbortError") throw new VisionAbortError();
    throw error;
  }
  const text = contentText(result.content).trim();
  if (!text) {
    throw new Error("API 未返回内容");
  }
  const tokenStr =
    typeof result.usage?.totalTokens === "number" ? String(result.usage.totalTokens) : "?";
  const labels = loaded.map((l) => l.label).join(", ");
  return `[${labels}]\n${text}\n[模型: ${model.id}, tokens: ${tokenStr}]`;
}

// ── extension ────────────────────────────────────────────────────────────────

export default function visionAgent(pi: ExtensionAPI) {
  // 只依赖 input 字段，不绑定 pi 内部类型
  interface AnyModel {
    id?: string;
    input?: readonly string[];
  }

  /**
   * 根据当前主模型能力同步工具可见性：
   * - 多模态 → 隐藏 describe_image，图片由 pi 原生透传，零额外 API 调用
   * - text-only → 启用 describe_image 代理
   */
  function syncVisionMode(model: AnyModel | undefined, notify?: (msg: string) => void) {
    const active = pi.getActiveTools();
    const hasTool = active.includes(TOOL_NAME);
    if (hasTool && isMultimodal(model)) {
      pi.setActiveTools(active.filter((t) => t !== TOOL_NAME));
      if (notify) notify(`主模型 ${model?.id ?? "?"} 支持视觉 → 已隐藏 ${TOOL_NAME}，图片原生透传`);
    } else if (!hasTool && !isMultimodal(model)) {
      pi.setActiveTools([...active, TOOL_NAME]);
      if (notify)
        notify(`主模型 ${model?.id ?? "?"} 不支持视觉 → 已启用 ${TOOL_NAME}，由视觉模型代理识别`);
    }
  }

  // 模型切换时自动同步（/model、Ctrl+P、会话恢复都会触发）
  pi.on("model_select", (event, ctx) => {
    syncVisionMode(event.model, (msg) => ctx.ui.notify(msg, "info"));
  });

  // 启动 / 会话恢复时初始化
  pi.on("session_start", (_event, ctx) => {
    syncVisionMode(ctx.model);
  });

  // 未配置视觉模型就不注册工具：agent 看不到也调不到。provider 的
  // baseUrl/apiKey 由 pi 的模型注册表在调用时解析（execute 里 find），
  // 配置好 settings.json / models.json 后重新加载（/reload）即可生效。
  const visionConfig = loadVisionConfig();
  if (!visionConfig?.model) return;

  pi.registerTool({
    name: TOOL_NAME,
    label: "Describe Image",
    description:
      "调用视觉模型识别图片文件内容，返回详细文字描述（适用于当前主模型不支持视觉的情况；主模型支持视觉时会自动隐藏本工具）。" +
      "参数：① path=本地图片路径（单个或数组，数组一次识别多张）；" +
      "② prompt=可选的具体描述要求（如「图中验证码是什么」「逐字翻译图中的文字」），缺省时自动生成通用描述指令。" +
      "聊天里粘贴的截图若当前模型不支持视觉，先用 write 工具存成文件再传 path。",
    promptSnippet: "调用视觉模型识别图片文件（可一次多张）",
    parameters: Type.Object({
      path: Type.Optional(
        Type.Union([
          Type.String({
            description: "本地图片路径，如 /path/to/screenshot.png。",
          }),
          Type.Array(
            Type.String({
              description: "多个本地图片路径，一次识别多张。",
            }),
          ),
        ]),
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            "可选：具体的描述要求，如「图中验证码是什么」「逐字翻译图中的文字」。缺省时自动生成通用描述指令。",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const paths = resolveImagePaths({ path: params.path });
        if (paths.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "需要提供 path（本地图片路径，单个或数组，数组一次识别多张）。",
              },
            ],
            details: { error: "no image path provided" },
          };
        }

        const visionConfig = loadVisionConfig();
        if (!visionConfig?.model) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `未配置视觉模型。请在 ${SETTINGS_PATH} 添加 visionConfig，例如: { "provider": "axonhub", "model": "mimo-v2.5" }`,
              },
            ],
            details: { error: "visionConfig not configured" },
          };
        }

        const providerName = visionConfig.provider ?? "default";
        const model = ctx.modelRegistry.find(providerName, visionConfig.model);
        if (!model) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `在模型注册表中找不到视觉模型「${providerName}/${visionConfig.model}」。请检查 models.json 是否配置了该 provider 与该模型。`,
              },
            ],
            details: { error: `model not found: ${providerName}/${visionConfig.model}` },
          };
        }

        const prompt = buildPrompt(params.prompt, paths.length);
        // 把发给视觉模型的 prompt 实时透传给主会话，识别要求对主模型可见
        onUpdate?.({
          content: [{ type: "text", text: `视觉识别 prompt: ${prompt}` }],
          details: { prompt },
        });

        const description = await callVision(
          ctx.modelRegistry,
          model,
          paths,
          prompt,
          signal ?? ctx.signal,
        );
        const markdown = buildPendantMarkdown({
          paths,
          prompt,
          description,
          provider: providerName,
          model: visionConfig.model,
        });
        return {
          content: [{ type: "text", text: description }],
          details: {
            provider: providerName,
            model: visionConfig.model,
            prompt,
            output: description,
            paths,
            count: paths.length,
            pendant: {
              markdown,
              expanded: true,
            } satisfies ToolPendant,
          },
        };
      } catch (error) {
        // 用户主动取消不是失败，不该以 isError 污染对话历史
        if (error instanceof VisionAbortError) {
          return {
            content: [{ type: "text", text: "图片识别已取消。" }],
            details: { cancelled: true },
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `识别失败: ${message}` }],
          details: {
            error: message,
            pendant: {
              markdown: `## 图片识别失败\n\n${message}`,
              expanded: true,
            } satisfies ToolPendant,
          },
        };
      }
    },
  });
}
