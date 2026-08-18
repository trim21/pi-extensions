/**
 * Agent discovery for the `spawn_agent` tool.
 *
 * Subagents are defined as markdown files in `~/.pi/agent/agents/*.md`
 * (user-level only; project-local agents are intentionally not supported).
 * Each file carries YAML frontmatter plus a system-prompt body:
 *
 *   ---
 *   name: scout
 *   description: Fast codebase recon
 *   tools:
 *     - read
 *     - grep
 *     - find
 *     - ls
 *   provider: openai           # optional; overrides the global default
 *   model: claude-haiku-4-5     # optional; overrides the global default
 *   thinkingLevel: high         # optional; overrides the global default
 *   ---
 *   System prompt for the agent goes here.
 *
 * Frontmatter is validated with a typebox schema; files that fail validation
 * (missing name/description, wrong field types) are skipped. If `tools` is
 * omitted, the subagent runs with the read-only default toolset from the
 * spawn-agent config (read/grep/find/ls) unless overridden there.
 *
 * Global defaults for provider/model/thinkingLevel come from
 * `~/.pi/agent/spawn-agent.json` (see loadSpawnAgentConfig); frontmatter
 * fields take precedence over them, which in turn take precedence over the
 * top-level defaultProvider/defaultModel/defaultThinkingLevel in pi's
 * settings.json.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/**
 * Valid thinking levels, mirroring pi's CLI --thinking validation
 * (VALID_THINKING_LEVELS). "off" disables thinking; "max" is deliberately
 * excluded — pi's CLI layer does not accept it.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const agentFrontmatterSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  tools: Type.Optional(Type.Array(Type.String())),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
});

function parseAgentFrontmatter(frontmatter: unknown) {
  try {
    return Value.Parse(agentFrontmatterSchema, frontmatter);
  } catch {
    return null;
  }
}

export interface AgentConfig {
  name: string;
  description: string;
  /** Toolset from the frontmatter; undefined means "use the config default". */
  tools?: string[];
  provider?: string;
  model?: string;
  /** Thinking level, applied via --thinking. */
  thinkingLevel?: (typeof THINKING_LEVELS)[number];
  systemPrompt: string;
  filePath: string;
}

/**
 * Global defaults resolved for subagents. Fields are optional: an absent
 * field means "not configured", and applyAgentDefaults leaves the frontmatter
 * value (or its absence) untouched.
 */
export interface SpawnAgentDefaults {
  provider?: string;
  model?: string;
  thinkingLevel?: (typeof THINKING_LEVELS)[number];
}

export function discoverAgents(dir = join(getAgentDir(), "agents")): AgentConfig[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const fm = parseAgentFrontmatter(frontmatter);
    if (!fm) continue; // missing name/description or wrong field types → not an agent

    agents.push({
      name: fm.name,
      description: fm.description,
      tools: fm.tools,
      provider: fm.provider,
      model: fm.model,
      thinkingLevel: fm.thinkingLevel,
      systemPrompt: body,
      filePath,
    });
  }
  return agents;
}

/**
 * Load the global subagent defaults from `~/.pi/agent/spawn-agent.json`,
 * falling back per-field to the top-level defaultProvider/defaultModel/
 * defaultThinkingLevel in pi's settings.json (same pattern as the vision and
 * session-name extensions). Returns undefined when the spawn-agent.json file
 * is missing, broken, or empty — in that case applyAgentDefaults leaves agents
 * untouched and the subagent inherits pi's own defaults.
 */
export function loadSpawnAgentConfig(
  spawnAgentPath: string,
  settingsPath: string,
): SpawnAgentDefaults | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(spawnAgentPath, "utf8"));
  } catch {
    return undefined; // 文件缺失或 JSON 损坏
  }
  let config: SpawnAgentDefaults;
  try {
    config = Value.Parse(spawnAgentConfigSchema, raw);
  } catch {
    return undefined; // 结构不符（非 object / thinkingLevel 非法等）
  }
  if (!config.provider && !config.model && !config.thinkingLevel) return undefined;

  let fallback: SpawnAgentSettingsFallback | undefined;
  try {
    fallback = Value.Parse(
      spawnAgentSettingsFallbackSchema,
      JSON.parse(readFileSync(settingsPath, "utf8")),
    );
  } catch {
    // settings.json 缺失或损坏：只用 spawn-agent.json 自身的字段
  }
  return {
    provider: nonEmpty(config.provider) ?? nonEmpty(fallback?.defaultProvider),
    model: nonEmpty(config.model) ?? nonEmpty(fallback?.defaultModel),
    thinkingLevel:
      config.thinkingLevel ??
      (isThinkingLevel(fallback?.defaultThinkingLevel) ? fallback.defaultThinkingLevel : undefined),
  };
}

/** spawn-agent.json 的 schema；thinkingLevel 限定与 frontmatter 相同的合法集合 */
const spawnAgentConfigSchema = Type.Object({
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
});

/** pi settings.json 顶层的兜底字段；thinkingLevel 用宽松字符串，解析后再过滤 */
const spawnAgentSettingsFallbackSchema = Type.Object({
  defaultProvider: Type.Optional(Type.String()),
  defaultModel: Type.Optional(Type.String()),
  defaultThinkingLevel: Type.Optional(Type.String()),
});

type SpawnAgentSettingsFallback = Static<typeof spawnAgentSettingsFallbackSchema>;

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function isThinkingLevel(value: string | undefined): value is (typeof THINKING_LEVELS)[number] {
  return value !== undefined && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Merge global defaults into discovered agents, field by field: a frontmatter
 * value always wins; otherwise the global default is used. Returns the input
 * array unchanged when there are no defaults.
 */
export function applyAgentDefaults(
  agents: AgentConfig[],
  defaults: SpawnAgentDefaults | undefined,
): AgentConfig[] {
  if (!defaults) return agents;
  return agents.map((agent) => ({
    ...agent,
    provider: agent.provider ?? defaults.provider,
    model: agent.model ?? defaults.model,
    thinkingLevel: agent.thinkingLevel ?? defaults.thinkingLevel,
  }));
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((a) => `${a.name}: ${a.description}`).join("; ");
}
