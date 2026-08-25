/**
 * openai-cost 配置：~/.pi/agent/openai-cost.json
 * 用 typebox 校验，解析失败或文件缺失时视为未配置。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const DEFAULT_PROVIDER_ID = "openai-cost";
export const DEFAULT_PROVIDER_NAME = "OpenAI Cost";
export const DEFAULT_API_KEY_ENV = "OPENAI_COST_API_KEY";
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 8192;
export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const modelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String()),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  baseUrl: Type.Optional(Type.String()),
});

const configSchema = Type.Object({
  id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  baseUrl: Type.String({ minLength: 1 }),
  apiKeyEnv: Type.Optional(Type.String()),
  models: Type.Optional(Type.Array(modelSchema)),
});

type RawConfig = Static<typeof configSchema>;

export interface OpenaiCostModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  baseUrl?: string;
}

export interface OpenaiCostConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  models?: OpenaiCostModelConfig[];
}

export function openaiCostConfigPath(): string {
  return join(homedir(), ".pi", "agent", "openai-cost.json");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeModel(model: Static<typeof modelSchema>): OpenaiCostModelConfig | undefined {
  const id = nonEmpty(model.id);
  if (!id) return undefined;
  const input = model.input?.filter((value) => value === "text" || value === "image") ?? [];
  return {
    id,
    name: nonEmpty(model.name) ?? id,
    reasoning: model.reasoning ?? false,
    input: input.length > 0 ? input : ["text"],
    contextWindow:
      model.contextWindow !== undefined && model.contextWindow > 0
        ? model.contextWindow
        : DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      model.maxTokens !== undefined && model.maxTokens > 0 ? model.maxTokens : DEFAULT_MAX_TOKENS,
    baseUrl: nonEmpty(model.baseUrl),
  };
}

function normalize(raw: RawConfig): OpenaiCostConfig {
  const models = raw.models
    ?.map((model) => normalizeModel(model))
    .filter((model): model is OpenaiCostModelConfig => model !== undefined);
  return {
    id: nonEmpty(raw.id) ?? DEFAULT_PROVIDER_ID,
    name: nonEmpty(raw.name) ?? DEFAULT_PROVIDER_NAME,
    baseUrl: raw.baseUrl.trim().replace(/\/+$/, ""),
    apiKeyEnv: nonEmpty(raw.apiKeyEnv) ?? DEFAULT_API_KEY_ENV,
    models: models && models.length > 0 ? models : undefined,
  };
}

export async function loadOpenaiCostConfig(
  path = openaiCostConfigPath(),
): Promise<OpenaiCostConfig | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  try {
    return normalize(Value.Parse(configSchema, raw));
  } catch {
    return undefined;
  }
}
