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
 *   model: claude-haiku-4-5     # optional
 *   thinkingLevel: high         # optional; applied as "model:high"
 *   ---
 *   System prompt for the agent goes here.
 *
 * Frontmatter is validated with a typebox schema; files that fail validation
 * (missing name/description, wrong field types) are skipped. If `tools` is
 * omitted, the subagent runs with the read-only default toolset from the
 * spawn-agent config (read/grep/find/ls) unless overridden there.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Valid thinking levels, mirroring pi's ThinkingLevel type. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const agentFrontmatterSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  tools: Type.Optional(Type.Array(Type.String())),
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
  model?: string;
  /** Thinking level, applied as a ":level" suffix on the model id. */
  thinkingLevel?: (typeof THINKING_LEVELS)[number];
  systemPrompt: string;
  filePath: string;
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
      model: fm.model,
      thinkingLevel: fm.thinkingLevel,
      systemPrompt: body,
      filePath,
    });
  }
  return agents;
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((a) => `${a.name}: ${a.description}`).join("; ");
}
