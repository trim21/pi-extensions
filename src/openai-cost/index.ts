/**
 * openai-cost —— OpenAI Chat Completions provider，费用取自响应 usage.cost，
 * 不用模型单价估算。配置：~/.pi/agent/openai-cost.json。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadOpenaiCostConfig } from "./config.js";
import { createOpenaiCostProvider } from "./provider.js";

export default async function openaiCostExtension(pi: ExtensionAPI) {
  const config = await loadOpenaiCostConfig();
  if (!config) return;
  pi.registerProvider(createOpenaiCostProvider(config));
}
