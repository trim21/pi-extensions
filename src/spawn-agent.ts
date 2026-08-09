/**
 * spawn_agent tool — delegate a task to a subagent running in a separate pi
 * process with an isolated context window.
 *
 * The subagent definition comes from `~/.pi/agent/agents/*.md` (markdown with
 * YAML frontmatter, see spawn-agent-agents.ts). The extension discovers the
 * available subagent types once at startup and appends them to the system
 * prompt on every agent start (same pattern as the bwrap extension), so the
 * model always knows which `agent` names it can pass to the tool. Execution
 * is blocking: the tool awaits the subagent process until it exits and
 * returns its final output to the parent model. Progress is streamed through
 * `onUpdate`, the same channel the built-in bash tool uses for live output.
 *
 * Security default: without an explicit `tools:` in the frontmatter, the
 * subagent only gets read-only tools (read/grep/find/ls) — no bash/write/edit.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getMarkdownTheme,
  truncateTail,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { type AgentConfig, discoverAgents, formatAgentList } from "./spawn-agent-agents.js";

// ── constants ────────────────────────────────────────────────────────────────

/** Subagent output returned to the parent model is capped at 50KB. */
const MAX_OUTPUT_BYTES = 50 * 1024;
/** Read-only toolset used when an agent does not declare `tools`. */
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];

// ── schema ───────────────────────────────────────────────────────────────────

const spawnAgentSchema = Type.Object({
  agent: Type.String({
    description:
      "Name of the subagent type to invoke. Choose one of the available subagent types listed in your system prompt.",
  }),
  task: Type.String({ description: "Task to delegate to the subagent" }),
});

// ── result types ─────────────────────────────────────────────────────────────

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SubagentDetails {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

/**
 * Resolve how to spawn the subagent process. Running through the current
 * entry script (when available) keeps model/tool/extension config identical
 * to the parent; otherwise fall back to the `pi` binary on PATH.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-spawn-agent-"));
  const safeName = agentName.replaceAll(/[^\w.-]+/g, "_");
  const filePath = join(dir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  });
  return filePath;
}

export function buildSubagentArgs(
  agent: AgentConfig,
  task: string,
  systemPromptPath: string | undefined,
): string[] {
  // --mode json: emit events as JSON lines; -p: single-shot answer;
  // --no-session: ephemeral, do not persist. --no-extensions keeps the
  // subagent clean (no recursive spawn_agent, no sandbox surprises).
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
  // Thinking level rides on the model shorthand ("model:level"); it cannot be
  // set without a model, so a level without a model is ignored.
  const model =
    agent.model !== undefined && agent.thinkingLevel !== undefined
      ? `${agent.model}:${agent.thinkingLevel}`
      : agent.model;
  if (model) args.push("--model", model);
  // Read-only default unless the agent explicitly declares a toolset.
  const tools = agent.tools ?? DEFAULT_TOOLS;
  args.push("--tools", tools.join(","));
  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  args.push(`Task: ${task}`);
  return args;
}

// ── subagent runner ──────────────────────────────────────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
): Promise<SubagentDetails> {
  const result: SubagentDetails = {
    agent: agent.name,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: agent.model,
  };

  let tmpPromptPath: string | null = null;
  try {
    if (agent.systemPrompt.trim()) {
      tmpPromptPath = await writePromptToTempFile(agent.name, agent.systemPrompt);
    }
    const args = buildSubagentArgs(agent, task, tmpPromptPath ?? undefined);
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // Mark the child as a subagent so extensions running inside it (e.g.
      // bwrap's subagent policy) can recognize and treat it accordingly.
      env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
    });

    const emitUpdate = () => {
      onUpdate?.({
        content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
        details: { ...result },
      });
    };

    let buffer = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return; // not a JSON event line
      }
      if (!isRecord(event)) return;

      if (event.type === "message_end" && isRecord(event.message)) {
        const msg = event.message as unknown as Message;
        result.messages.push(msg);
        if (msg.role === "assistant") {
          result.usage.turns++;
          const usage: Record<string, unknown> = isRecord(msg.usage) ? msg.usage : {};
          result.usage.input += num(usage.input);
          result.usage.output += num(usage.output);
          result.usage.cacheRead += num(usage.cacheRead);
          result.usage.cacheWrite += num(usage.cacheWrite);
          result.usage.cost += num(isRecord(usage.cost) ? usage.cost.total : undefined);
          result.usage.contextTokens = num(usage.totalTokens);
          if (!result.model && typeof msg.model === "string") result.model = msg.model;
          if (typeof msg.stopReason === "string") result.stopReason = msg.stopReason;
          if (typeof msg.errorMessage === "string") result.errorMessage = msg.errorMessage;
        }
        emitUpdate();
      } else if (event.type === "tool_result_end" && isRecord(event.message)) {
        result.messages.push(event.message as unknown as Message);
        emitUpdate();
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      result.stderr += data.toString();
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", () => resolve(1));

      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal) {
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
    return result;
  } finally {
    if (tmpPromptPath) {
      try {
        await rm(tmpPromptPath, { force: true });
        await rm(dirname(tmpPromptPath), { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Session entry customType used to mark the injected subagent list. */
export function formatAgentListSection(agents: AgentConfig[]): string {
  const lines = agents.map((a) => `- \`${a.name}\`: ${a.description}`);
  return [
    "## Available subagents",
    "",
    "You can delegate tasks to the following subagent types by calling the `spawn_agent` tool with their name in the `agent` parameter:",
    "",
    ...lines,
  ].join("\n");
}

// ── extension ────────────────────────────────────────────────────────────────

export default function spawnAgent(pi: ExtensionAPI) {
  // Discover the available subagent types once at extension startup. The
  // extension owns this discovery: the model never has to guess agent names
  // or read the agent directory itself. Editing ~/.pi/agent/agents/*.md
  // requires /reload to take effect.
  const agents = discoverAgents();
  const agentListSection = agents.length > 0 ? formatAgentListSection(agents) : null;

  if (agentListSection) {
    // Same pattern as the bwrap extension: append the list to the system
    // prompt on every agent start. The system prompt is rebuilt each turn
    // anyway, so a persistent per-session injection would add no value.
    pi.on("before_agent_start", (event) => {
      return { systemPrompt: `${event.systemPrompt}\n\n${agentListSection}` };
    });
  }

  pi.registerTool<typeof spawnAgentSchema, SubagentDetails>({
    name: "spawn_agent",
    label: "spawn_agent",
    description: [
      "Delegate a task to a subagent running in a separate pi process with an isolated context window.",
      "The `agent` parameter must be one of the available subagent types listed in the system prompt.",
      `Subagents run read-only (${DEFAULT_TOOLS.join(", ")}) unless the agent declares an explicit toolset.`,
    ].join(" "),
    parameters: spawnAgentSchema,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agent = agents.find((a) => a.name === params.agent);
      if (!agent) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown agent "${params.agent}". Available agents: ${formatAgentList(agents)}`,
            },
          ],
          details: {
            agent: params.agent,
            task: params.task,
            exitCode: 1,
            messages: [],
            stderr: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
          isError: true,
        };
      }

      const result = await runAgent(agent, params.task, ctx.cwd, signal, onUpdate);

      const isError =
        result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
      if (isError) {
        const reason =
          result.stopReason ?? (result.exitCode === 0 ? "failed" : `exit ${result.exitCode}`);
        const message =
          result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
        return {
          content: [
            { type: "text", text: `Subagent "${result.agent}" failed (${reason}): ${message}` },
          ],
          details: result,
          isError: true,
        };
      }

      const output = getFinalOutput(result.messages) || "(no output)";
      const truncation = truncateTail(output, { maxBytes: MAX_OUTPUT_BYTES });
      const text = truncation.truncated
        ? `${truncation.content}\n\n[Output truncated to ${formatTokens(truncation.content.length)} bytes. Full result preserved in tool details.]`
        : output;
      return { content: [{ type: "text", text }], details: result };
    },

    renderCall(args, theme) {
      const preview = args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task;
      let text = theme.fg("toolTitle", theme.bold("spawn_agent ")) + theme.fg("accent", args.agent);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details;
      const isError =
        details.exitCode !== 0 ||
        details.stopReason === "error" ||
        details.stopReason === "aborted";
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const finalOutput = getFinalOutput(details.messages);
      const usageStr = formatUsageStats(details.usage, details.model);

      if (expanded) {
        const container = new Container();
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(details.agent))}${
          details.stopReason ? ` ${theme.fg("error", `[${details.stopReason}]`)}` : ""
        }`;
        container.addChild(new Text(header, 0, 0));
        if (isError && details.errorMessage) {
          container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
        }
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
        container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
        if (finalOutput) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
        }
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.agent))}`;
      if (isError && details.errorMessage) {
        text += `\n${theme.fg("error", `Error: ${details.errorMessage}`)}`;
      } else if (finalOutput) {
        text += `\n${theme.fg("toolOutput", finalOutput.split("\n").slice(0, 5).join("\n"))}`;
      } else {
        text += `\n${theme.fg("muted", "(no output)")}`;
      }
      if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
      return new Text(text, 0, 0);
    },
  });
}
