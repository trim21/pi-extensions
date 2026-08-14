/**
 * session-name —— 自动会话命名扩展
 *
 * 在会话收到第一个 user prompt 时自动生成显示名，方便在 /resume 和 pi -r
 * 中区分会话：
 * - 配置了 sessionName.model 时，通过 pi 的模型注册表（ctx.modelRegistry）
 *   直接调用命名模型把 prompt 概括成短名 —— 复用 pi 的 provider 解析
 *   （~/.pi/agent/models.json 的 baseUrl/apiKey/env/OAuth）与 AI SDK，
 *   不手写 HTTP 请求（模型来自 ~/.pi/agent/settings.json 的 sessionName 与
 *   defaultProvider，与 vision-agent 同一套配置体系）；
 * - 未配置模型、模型在注册表中找不到或模型调用失败时退化为启发式命名
 *   （取首行、去 markdown 装饰、截断到 maxLength）。
 *
 * 已命名的会话（--name / /name / 恢复的已命名 session）不会被覆盖；
 * 恢复的无名会话从历史第一条 user 消息生成名字。命名在后台进行，不阻塞
 * agent 启动；会话切换 / reload 后捕获的 pi 会抛 stale 错误，被 catch
 * 忽略，名字绝不会写到错误的 session。
 *
 * 使用前提：无。未配置 sessionName 时开箱即用（启发式命名）。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  contentText,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── constants ────────────────────────────────────────────────────────────────

/** ~/.pi/agent/settings.json：sessionName 配置所在文件 */
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
/** 会话名最大长度（字符），模型命名与启发式共用 */
export const DEFAULT_MAX_LENGTH = 30;
/** 命名请求超时。ctx.signal 在 agent 空闲时为 undefined，不能只依赖它 */
export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * 命名模型输出上限。命名任务本身简单，但 reasoning 模型（如 deepseek-v4-flash）
 * 会先输出推理过程再给最终名字：64 太小会在推理阶段被截断导致 content 为空，
 * 调大到与 vision-agent 的 DEFAULT_MAX_TOKENS 一致，保证推理模型正常出结果。
 */
export const NAMER_MAX_TOKENS = 4096;

// ── types ────────────────────────────────────────────────────────────────────

export interface SessionNameConfig {
  provider?: string;
  model?: string;
  maxLength?: number;
}

/**
 * 命名所需的模型注册表操作：扩展传 ctx.modelRegistry，测试传 mock。
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

/** 命名所需的 session 操作：扩展传 pi，测试传 mock */
export interface NamerAPI {
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
}

/** 触发时的 UI / 模型上下文；print / json 模式（hasUI=false）下不通知 */
export interface SessionNamingContext {
  hasUI?: boolean;
  notify?: (message: string) => void;
  /** 模型注册表（ctx.modelRegistry），用于按 provider/model 解析并调用命名模型 */
  registry?: ModelRegistryLike;
  /** 当前 abort signal；agent 空闲时为 undefined */
  signal?: AbortSignal;
}

/** 只依赖 type/message.role/content 字段，不绑定 pi 内部类型 */
export interface UserMessageLike {
  type: string;
  message?: { role?: string; content?: unknown } | null;
}

// ── 配置解析（纯函数，可测试）───────────────────────────────────────────────

/**
 * 读取 ~/.pi/agent/settings.json 的 sessionName 配置。
 * provider 缺省时回退到 defaultProvider；文件缺失 / JSON 损坏 / 无 sessionName
 * 时返回 undefined。
 */
export function loadSessionNameConfig(settingsPath = SETTINGS_PATH): SessionNameConfig | undefined {
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
    const sn = settings.sessionName;
    if (!sn || typeof sn !== "object" || Array.isArray(sn)) return undefined;
    const config = sn as Record<string, unknown>;
    const provider =
      typeof config.provider === "string" ? config.provider.trim() || undefined : undefined;
    const defaultProvider =
      typeof settings.defaultProvider === "string"
        ? settings.defaultProvider.trim() || undefined
        : undefined;
    const maxLength =
      typeof config.maxLength === "number" && config.maxLength > 0
        ? Math.floor(config.maxLength)
        : undefined;
    return {
      provider: provider ?? defaultProvider,
      model: typeof config.model === "string" ? config.model.trim() || undefined : undefined,
      maxLength,
    };
  } catch {
    return undefined;
  }
}

// ── 文本提取与命名生成（纯函数，可测试）────────────────────────────────────

/** 从消息 content（字符串或分片数组）提取文本 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (
        part &&
        typeof part === "object" &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        return (part as Record<string, unknown>).text as string;
      }
      return "";
    })
    .join("")
    .trim();
}

/**
 * 取要命名的 prompt 文本：新会话（branch 为空）用当前 prompt；
 * 恢复的会话从历史找第一条 user 消息。找不到可命名文本时返回 undefined。
 */
export function extractFirstUserPrompt(
  branch: readonly UserMessageLike[],
  currentPrompt: string,
): string | undefined {
  const trimmed = currentPrompt.trim();
  if (branch.length > 0) {
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const text = messageText(entry.message?.content);
      if (text) return text;
    }
  }
  return trimmed || undefined;
}

/** 折叠空白、限制长度；空结果返回 undefined */
export function sanitizeName(raw: string, maxLength = DEFAULT_MAX_LENGTH): string | undefined {
  const collapsed = raw.replaceAll(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * 启发式命名：取第一个非空行（首行为代码围栏时跳过），去掉常见 markdown
 * 装饰，截断到 maxLength。适用于未配置命名模型、模型调用失败等场景。
 */
export function heuristicName(text: string, maxLength = DEFAULT_MAX_LENGTH): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const first = lines[0];
  // "```" / "```ts" 之类的纯代码围栏行不是内容，取下一行
  const line = first && /^`{1,3}\w*$/.test(first) ? (lines[1] ?? first) : first;
  if (!line) return undefined;
  const cleaned = line
    .replace(/^#{1,6}\s+/, "") // 标题
    .replace(/^[-*+]\s+/, "") // 无序列表
    .replace(/^\d+[.)]\s+/, "") // 有序列表
    .replace(/^>\s?/, "") // 引用
    .replace(/^`{1,3}/, "") // 行首代码围栏 / 行内代码
    .replace(/`{1,3}$/, "") // 行尾代码围栏
    .trim();
  return sanitizeName(cleaned || line, maxLength);
}

// ── 命名模型调用 ─────────────────────────────────────────────────────────────

/** 命名模型的 system prompt：只输出一个短名 */
export function buildNamerPrompt(maxLength: number): string {
  return [
    "你是一个会话命名助手。根据用户给出的第一条消息内容，生成一个简洁的会话显示名。",
    `要求：不超过 ${maxLength} 个字符，概括消息主题；只输出名字本身，不要引号、标点、解释或多余说明。`,
    "消息是中文时用中文命名，英文时用英文命名，保持原有语言。",
  ].join("\n");
}

/** 合并调用方 signal 与本地超时；调用方未传时仍然有超时兜底 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 通过模型注册表调用命名模型，让模型把 prompt 概括成短名。
 * 走 pi 的 AI SDK（modelRegistry.complete），复用 provider 解析与
 * thinking/重试/usage 等基础设施，不手写 HTTP 请求。
 *
 * 注意：contentText 只取 content 里的 text 块（自动排除 thinking），
 * 推理模型的思考过程不会被当作会话名。
 *
 * @returns 模型返回的原始文本（未清洗，需再经 sanitizeName）
 */
export async function callNamer(
  registry: ModelRegistryLike,
  model: Model<Api>,
  text: string,
  maxLength: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await registry.complete(
    model,
    {
      systemPrompt: buildNamerPrompt(maxLength),
      messages: [{ role: "user", content: text, timestamp: Date.now() }],
    },
    { maxTokens: NAMER_MAX_TOKENS, signal: withTimeout(signal, REQUEST_TIMEOUT_MS) },
  );
  const output = contentText(result.content).trim();
  if (!output) {
    throw new Error("API 未返回内容");
  }
  return output;
}

// ── 命名编排 ─────────────────────────────────────────────────────────────────

/**
 * 生成会话名：配置了命名模型且能在注册表中解析到模型时优先用模型生成
 * （失败退化），否则用启发式。模型输出与启发式结果都经过 sanitizeName，
 * 保证 ≤ maxLength。
 */
export async function generateSessionName(
  text: string,
  config: SessionNameConfig | undefined,
  options: {
    registry?: ModelRegistryLike;
    signal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  const maxLength = config?.maxLength ?? DEFAULT_MAX_LENGTH;
  const model = config?.model;
  if (model) {
    const registry = options.registry;
    const resolved = registry?.find(config.provider ?? "default", model);
    if (registry && resolved) {
      const raw = await callNamer(registry, resolved, text, maxLength, options.signal).catch(
        () => "",
      );
      if (raw) {
        const name = sanitizeName(raw, maxLength);
        if (name) return name;
      }
    }
  }
  return heuristicName(text, maxLength);
}

/**
 * 完整命名流程：读配置 → 生成名字 → 设置会话名并通知。
 * 失败（如会话已切换导致 pi stale）由调用方 catch 忽略。
 */
export async function nameSession(
  pi: NamerAPI,
  text: string,
  ctx: SessionNamingContext = {},
): Promise<void> {
  const config = loadSessionNameConfig();
  const name = await generateSessionName(text, config, {
    registry: ctx.registry,
    signal: ctx.signal,
  });
  if (!name) return;
  pi.setSessionName(name);
  if (ctx.hasUI && ctx.notify) {
    ctx.notify(`会话已命名为: ${name}`);
  }
}

// ── extension ────────────────────────────────────────────────────────────────

export default function sessionNameExtension(pi: ExtensionAPI) {
  // 首个 user prompt 到达时自动命名。命名是后台副作用，不阻塞 agent 启动；
  // 会话切换 / reload 后捕获的 pi 会抛 stale 错误，被 catch 忽略，名字
  // 绝不会写到错误的 session。
  pi.on("before_agent_start", (event, ctx) => {
    if (pi.getSessionName()) return;
    const text = extractFirstUserPrompt(ctx.sessionManager.getBranch(), event.prompt);
    if (!text) return;
    void nameSession(pi, text, {
      hasUI: ctx.hasUI,
      notify: (message) => ctx.ui.notify(message, "info"),
      registry: ctx.modelRegistry,
      signal: ctx.signal,
    }).catch(() => {
      return; // 会话切换 / reload 后 pi 已 stale，名字不会写错 session，忽略即可
    });
  });
}
