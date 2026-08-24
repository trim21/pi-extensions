import process from "node:process";

import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type Provider,
  type ProviderStreams,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  type OpenaiCostConfig,
  type OpenaiCostModelConfig,
  ZERO_COST,
} from "./config.js";
import { createReportedCostCapture, wrapStreamWithReportedCost } from "./cost.js";

const remoteModelsSchema = Type.Object(
  {
    data: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          name: Type.Optional(Type.String()),
          context_window: Type.Optional(Type.Number()),
          max_tokens: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

type RemoteModels = Static<typeof remoteModelsSchema>;

export function toPiModel(
  config: OpenaiCostConfig,
  model: OpenaiCostModelConfig,
): Model<"openai-completions"> {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    provider: config.id,
    baseUrl: model.baseUrl ?? config.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    cost: { ...ZERO_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export function mapRemoteModels(
  config: OpenaiCostConfig,
  payload: RemoteModels,
): Model<"openai-completions">[] {
  const models: Model<"openai-completions">[] = [];
  for (const item of payload.data) {
    const id = item.id.trim();
    if (!id) continue;
    models.push(
      toPiModel(config, {
        id,
        name: item.name?.trim() || id,
        reasoning: false,
        input: ["text"],
        contextWindow:
          item.context_window && item.context_window > 0
            ? item.context_window
            : DEFAULT_CONTEXT_WINDOW,
        maxTokens: item.max_tokens && item.max_tokens > 0 ? item.max_tokens : DEFAULT_MAX_TOKENS,
      }),
    );
  }
  return models;
}

export async function fetchRemoteModels(
  config: OpenaiCostConfig,
  options: { apiKey?: string; signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<Model<"openai-completions">[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  const response = await fetchImpl(modelsUrl(config.baseUrl), { headers, signal: options.signal });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`openai-cost /models ${response.status}: ${raw.slice(0, 300)}`);
  }
  return mapRemoteModels(config, Value.Parse(remoteModelsSchema, JSON.parse(raw) as unknown));
}

function withReportedCost(api: ProviderStreams): ProviderStreams {
  const wrap = (
    run: (fetch: typeof globalThis.fetch) => ReturnType<ProviderStreams["stream"]>,
    fetch: typeof globalThis.fetch | undefined,
  ) => {
    const capture = createReportedCostCapture(fetch ?? globalThis.fetch);
    return wrapStreamWithReportedCost(run(capture.fetch), capture.wait);
  };
  return {
    stream: (model, context, options) =>
      wrap((fetch) => api.stream(model, context, { ...options, fetch }), options?.fetch),
    streamSimple: (model, context, options) =>
      wrap((fetch) => api.streamSimple(model, context, { ...options, fetch }), options?.fetch),
  };
}

function apiKeyFromRefresh(context: RefreshModelsContext, apiKeyEnv: string): string | undefined {
  if (context.credential?.type === "api_key" && context.credential.key) {
    return context.credential.key;
  }
  const envValue = process.env[apiKeyEnv];
  return envValue?.trim() || undefined;
}

export function createOpenaiCostProvider(
  config: OpenaiCostConfig,
  options: { api?: ProviderStreams; fetch?: typeof globalThis.fetch } = {},
): Provider<"openai-completions"> {
  const api = withReportedCost(options.api ?? openAICompletionsApi());
  const staticModels = config.models?.map((model) => toPiModel(config, model)) ?? [];
  return createProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${config.name} API key`, [config.apiKeyEnv]) },
    models: staticModels,
    fetchModels:
      staticModels.length > 0
        ? undefined
        : async (context) =>
            fetchRemoteModels(config, {
              apiKey: apiKeyFromRefresh(context, config.apiKeyEnv),
              signal: context.signal,
              fetch: options.fetch,
            }),
    api,
  });
}
