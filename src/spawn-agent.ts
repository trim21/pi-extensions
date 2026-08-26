/**
 * spawn_agent tool — delegate a task to a subagent with an isolated context
 * window, running in-process via the pi SDK (createAgentSession) instead of a
 * separate process speaking stdio RPC.
 *
 * The subagent definition comes from `~/.pi/agent/agents/*.md` (markdown with
 * YAML frontmatter, see spawn-agent-agents.ts). The extension discovers the
 * available subagent types once at startup and injects the list via the tool's
 * `promptGuidelines`, so the model always knows which `agent` names it can
 * pass to the tool. Execution
 * is blocking: the tool awaits the subagent session until the turn settles and
 * returns its final output to the parent model. Progress is streamed through
 * `onUpdate`, the same channel the built-in bash tool uses for live output.
 * Progress is a rolling log: `tool: <name>` lines for tool calls and
 * `text: <content>` lines for completed text blocks, keeping the last
 * `MAX_PROGRESS_LINES` lines. Consecutive tool calls are merged into a
 * single `tool:` line (`read x 2, glob`) and over-long line content is
 * folded to the first/last 7 chars joined by `…`, so a burst of tool calls
 * or a long text block does not flood the window; any text block starts a
 * new line.
 *
 * Security default: without an explicit `tools:` in the frontmatter, the
 * subagent only gets read-only tools (read/grep/find/ls) — no bash/write/edit.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionUIContext,
  getAgentDir,
  ModelRuntime,
  type PromptOptions,
  SessionManager,
  SettingsManager,
  truncateTail,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type ToolPendant } from "./lib/pendant.js";
import {
  type AgentConfig,
  applyAgentDefaults,
  discoverAgents,
  formatAgentList,
  loadSpawnAgentConfig,
} from "./spawn-agent-agents.js";

// ── constants ────────────────────────────────────────────────────────────────

/** Subagent output returned to the parent model is capped at 50KB. */
const MAX_OUTPUT_BYTES = 50 * 1024;
/** Read-only toolset used when an agent does not declare `tools`. */
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
/** Progress log keeps only the most recent lines (rolling window). */
const MAX_PROGRESS_LINES = 5;
/** Progress line content (without the `tool:` / `text:` prefix) is capped at 21 chars; longer text is folded to the first/last 9 chars joined by ` … `. */
const MAX_PROGRESS_CHARS_PER_LINE = 21;
/** 错误消息里 stderr 的展示上限。 */
const MAX_STDERR_ERROR_BYTES = 4 * 1024;
/** 全局默认配置：~/.pi/agent/spawn-agent.json，字段可被 frontmatter 覆盖。 */
const SPAWN_AGENT_CONFIG_PATH = join(getAgentDir(), "spawn-agent.json");
const SETTINGS_PATH = join(getAgentDir(), "settings.json");

/**
 * Tool → extension override map: when a subagent's frontmatter enables a
 * built-in tool, the matching opencode extension is loaded via the SDK's
 * `additionalExtensionPaths` so the subagent uses the enhanced implementation
 * instead of the built-in one.
 *
 * The bash override also carries the bwrap sandbox: opencode/bash.ts creates
 * its own bwrap runtime instance and runs commands through runtime.execute(),
 * so agents that declare the bash tool get sandboxing automatically. Agents
 * without bash need no bwrap setup (there are no commands to sandbox).
 * (Workspace write protection is embedded in the opencode write/edit tools.)
 *
 * Claude Code style tools (capitalized names) map to their claude-code
 * files, so a subagent can enable exactly the tools it declares — e.g. `Grep`
 * without `Glob`. The stateful file tools (`Read`/`Edit`/`Write`) share one
 * implementation file (they share a read-snapshot state); the `tools`
 * allowlist still exposes only the declared subset. The opencode file tools
 * (read/edit/write) likewise share opencode/files.ts (they share the LSP
 * service instance).
 */
const TOOL_EXTENSION_OVERRIDES: Record<string, string> = {
  read: "opencode/files.ts",
  edit: "opencode/files.ts",
  write: "opencode/files.ts",
  bash: "opencode/bash.ts",
  Grep: "claude-code/grep.ts",
  Glob: "claude-code/glob.ts",
  Read: "claude-code/files.ts",
  Edit: "claude-code/files.ts",
  Write: "claude-code/files.ts",
};

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
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SubagentDetails {
  agent: string;
  task: string;
  exitCode: number;
  messages: AgentMessage[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  /** 折叠 markdown 面板：父 agent 的 prompt 与父 agent 看到的子 agent 结果。 */
  pendant?: ToolPendant;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function getFinalOutput(messages: AgentMessage[]): string {
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

/**
 * 组装失败消息，按来源分行（error/stderr/output）让父模型能分辨信息出处；
 * stderr 截断到尾部（错误信息通常在最后）。全空时保底 "(no output)"，
 * 避免只回一个 exit code。
 */
export function formatSubagentError(result: SubagentDetails): { reason: string; message: string } {
  const reason =
    result.stopReason ?? (result.exitCode === 0 ? "failed" : `exit ${result.exitCode}`);
  const parts: string[] = [];
  if (result.errorMessage) parts.push(`error: ${result.errorMessage}`);
  const stderr = truncateTail(result.stderr, { maxBytes: MAX_STDERR_ERROR_BYTES });
  if (stderr.content.trim()) {
    const truncatedMark = stderr.truncated ? "\n[stderr truncated]" : "";
    parts.push(`stderr: ${stderr.content.trim()}${truncatedMark}`);
  }
  const output = getFinalOutput(result.messages);
  if (output) parts.push(`output: ${output}`);
  return { reason, message: parts.length > 0 ? parts.join("\n") : "(no output)" };
}

/**
 * Fold over-long progress line content: keep the first/last 9 chars joined by
 * ` … ` (space, ellipsis, space), so the folded line never exceeds
 * `MAX_PROGRESS_CHARS_PER_LINE` chars (9 + 3 + 9 = 21). Shorter text is
 * returned as-is.
 */
function foldProgressLine(text: string): string {
  if (text.length <= MAX_PROGRESS_CHARS_PER_LINE) return text;
  const keep = Math.floor((MAX_PROGRESS_CHARS_PER_LINE - 3) / 2);
  return `${text.slice(0, keep)} … ${text.slice(-keep)}`;
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
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

/** 子 agent 结果的折叠面板 markdown：父 agent 的 prompt 与父 agent 看到的结果。 */
function formatPendantMarkdown(task: string, response: string): string {
  return `# prompt:\n${task.trim()}\n# response\n${response.trim()}`;
}

/**
 * Resolve a sibling extension file (relative to this module) to an absolute
 * path, so `additionalExtensionPaths` works both when running from the source
 * tree and from an installed pi package (node_modules). A missing extension is
 * fatal: silently skipping a guard (e.g. bwrap) would leave the subagent
 * unprotected.
 */
function extensionPath(fileName: string): string {
  const abs = fileURLToPath(new URL(fileName, import.meta.url));
  if (!existsSync(abs)) {
    throw new Error(`Extension file not found: ${abs}`);
  }
  return abs;
}

/**
 * Load the override extension for each declared tool (read/edit/write → opencode
 * files.ts, bash → opencode bash.ts, ...), so the subagent uses the enhanced
 * implementation instead of the built-in one. Several tool names can map to
 * the same implementation file (e.g. cc Read/Edit/Write → claude-code/files.ts);
 * loading a file twice would run its extension factory twice and create
 * separate closure states, so each file is loaded at most once.
 */
export function overrideExtensionPaths(tools: string[]): string[] {
  const loaded = new Set<string>();
  const paths: string[] = [];
  for (const tool of tools) {
    const ext = TOOL_EXTENSION_OVERRIDES[tool];
    if (ext && !loaded.has(ext)) {
      loaded.add(ext);
      paths.push(extensionPath(ext));
    }
  }
  return paths;
}

/**
 * Resolve the frontmatter model to a runtime Model. A "provider/model" string
 * carries its own provider; a bare model id uses the declared provider, then
 * the settings default provider (the CLI's implicit resolution when no
 * --provider was passed). Returns undefined when no model is configured, which
 * lets createAgentSession fall back to the settings default.
 */
export function resolveModel(
  modelRuntime: ModelRuntime,
  agent: AgentConfig,
  settingsManager: SettingsManager,
): ReturnType<ModelRuntime["getModel"]> {
  if (!agent.model) return undefined;
  const slash = agent.model.indexOf("/");
  if (slash > 0) {
    return modelRuntime.getModel(agent.model.slice(0, slash), agent.model.slice(slash + 1));
  }
  if (agent.provider) return modelRuntime.getModel(agent.provider, agent.model);
  const defaultProvider = settingsManager.getDefaultProvider();
  return defaultProvider ? modelRuntime.getModel(defaultProvider, agent.model) : undefined;
}

// ── subagent runner ──────────────────────────────────────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function toolSegment(name: string, count: number): string {
  return count > 1 ? `${name} x ${count}` : name;
}

/** The subset of AgentSession runAgent relies on (injectable for tests). */
export interface SubagentSession {
  agent: { state: { messages: AgentMessage[] } };
  subscribe(listener: AgentSessionEventListener): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export type SessionFactory = (
  agent: AgentConfig,
  cwd: string,
  parentUI: ExtensionUIContext | undefined,
) => Promise<SubagentSession>;

/**
 * Create the subagent session via the pi SDK: an in-memory session (no disk
 * session recovery or persistence, same as the old --no-session child), a
 * resource loader that discovers only the per-tool override extensions
 * (equivalent to --no-extensions + -e), and the parent UI bound directly so
 * subagent extensions show their dialogs in the parent without RPC.
 */
export async function createSubagentSession(
  agent: AgentConfig,
  cwd: string,
  parentUI: ExtensionUIContext | undefined,
): Promise<AgentSession> {
  const settingsManager = SettingsManager.create(cwd, getAgentDir());
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: overrideExtensionPaths(agent.tools ?? DEFAULT_TOOLS),
    appendSystemPrompt: agent.systemPrompt ? [agent.systemPrompt] : undefined,
  });
  await loader.reload();

  const modelRuntime = await ModelRuntime.create();
  const { session } = await createAgentSession({
    cwd,
    model: resolveModel(modelRuntime, agent, settingsManager),
    thinkingLevel: agent.thinkingLevel,
    tools: agent.tools ?? DEFAULT_TOOLS,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader: loader,
    modelRuntime,
  });
  await session.bindExtensions({ uiContext: parentUI, mode: "rpc" });
  return session;
}

export async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  parentUI?: ExtensionUIContext,
  createSession: SessionFactory = createSubagentSession,
): Promise<SubagentDetails> {
  const result: SubagentDetails = {
    agent: agent.name,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: agent.model,
  };

  let session: SubagentSession;
  try {
    session = await createSession(agent, cwd, parentUI);
  } catch (error) {
    result.errorMessage = error instanceof Error ? error.message : String(error);
    result.stopReason = "error";
    result.exitCode = 1;
    return result;
  }

  let logLines: string[] = [];
  // 工具调用行合并:连续的 tool_execution_start 事件合并在同一 `tool:` 行
  // (如 `tool: read x 2, glob`),相同工具名连续出现时计为 `name x N`,
  // 不同名按调用顺序罗列;任何非工具行都会打断合并。
  let toolLineSegments: string[] = [];
  let toolLine: { name: string; count: number } | undefined;

  const pushLogLine = (line: string) => {
    logLines.push(line);
    if (logLines.length > MAX_PROGRESS_LINES) {
      logLines = logLines.slice(-MAX_PROGRESS_LINES);
    }
    // 任何非工具行都会打断工具调用合并,下一批调用另起一行。
    toolLine = undefined;
  };

  const appendToolLine = (name: string) => {
    const firstInBatch = toolLine === undefined;
    if (toolLine === undefined) {
      toolLineSegments = [];
      toolLine = { name, count: 1 };
    } else if (toolLine.name === name) {
      toolLine.count++;
    } else {
      toolLineSegments.push(toolSegment(toolLine.name, toolLine.count));
      toolLine = { name, count: 1 };
    }
    const parts = [...toolLineSegments, toolSegment(toolLine.name, toolLine.count)].join(", ");
    const line = `tool: ${foldProgressLine(parts)}`;
    if (firstInBatch) {
      logLines.push(line);
      if (logLines.length > MAX_PROGRESS_LINES) {
        logLines = logLines.slice(-MAX_PROGRESS_LINES);
      }
    } else {
      logLines[logLines.length - 1] = line;
    }
    emitUpdate();
  };

  const emitUpdate = () => {
    // Usage line rides on the last row so the TUI always shows live token
    // cost; it lives outside the rolling window so it is never trimmed.
    const usageLine = formatUsageStats(result.usage, result.model);
    const lines = usageLine ? [...logLines, usageLine] : logLines;
    onUpdate?.({
      content: [{ type: "text", text: lines.join("\n") || "(running...)" }],
      details: { ...result },
    });
  };

  const handleEvent = (event: AgentSessionEvent) => {
    switch (event.type) {
      case "message_update": {
        // A completed text block (text_end carries the full content) becomes a
        // `text:` log line. Deltas/thinking are intentionally not logged.
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_end") {
          pushLogLine(`text: ${foldProgressLine(delta.content)}`);
          emitUpdate();
        }

        break;
      }
      case "tool_execution_start": {
        appendToolLine(event.toolName);
        break;
      }
      case "message_end": {
        const msg = event.message;
        result.messages.push(msg);
        if (msg.role === "assistant") {
          result.usage.turns++;
          result.usage.cost += msg.usage.cost.total;
          result.usage.contextTokens = msg.usage.totalTokens;
          if (!result.model) result.model = msg.model;
          result.stopReason = msg.stopReason;
          if (msg.errorMessage) result.errorMessage = msg.errorMessage;
        }
        emitUpdate();

        break;
      }
      // agent_settled 等事件无需处理：prompt() resolve 即本轮结束。
      // No default
    }
  };

  const unsubscribe = session.subscribe(handleEvent);
  const onAbort = () => {
    // abort 可能发生在子代理产生任何结果之前；标记 aborted 让上层
    // 识别中断（已有 stopReason 则保留，避免误报）。
    result.stopReason ??= "aborted";
    void session.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await session.prompt(`Task: ${task}`, { source: "rpc" });
  } catch (error) {
    if (result.stopReason !== "aborted") {
      result.errorMessage = error instanceof Error ? error.message : String(error);
      result.stopReason = "error";
    }
  } finally {
    unsubscribe();
    session.dispose();
  }

  // abort/error 没有退出码可依，由 stopReason 推导（语义同子进程退出码）。
  result.exitCode = result.stopReason === "error" || result.stopReason === "aborted" ? 1 : 0;
  return result;
}

/** Session entry customType used to mark the injected subagent list. */
export function formatAgentListSection(agents: AgentConfig[]): string {
  const lines = agents.map((a) => `- \`${a.name}\`: ${a.description}`);
  return [
    "### Available subagents",
    "",
    "You can delegate tasks to the following subagent types by calling the `spawn-agent` tool with their name in the `agent` parameter:",
    "",
    ...lines,
  ].join("\n");
}

// ── extension ────────────────────────────────────────────────────────────────

export default function spawnAgent(pi: ExtensionAPI) {
  // Windows 上禁用：子代理的工具集依赖 POSIX 设施（opencode bash 的
  // bwrap 沙箱、信号处理），不做 Windows 适配。
  if (process.platform === "win32") {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("spawn-agent is disabled on Windows.", "warning");
    });
    return;
  }

  // Discover the available subagent types once at extension startup. The
  // extension owns this discovery: the model never has to guess agent names
  // or read the agent directory itself. Editing ~/.pi/agent/agents/*.md or
  // ~/.pi/agent/spawn-agent.json requires /reload to take effect.
  const agents = applyAgentDefaults(
    discoverAgents(),
    loadSpawnAgentConfig(SPAWN_AGENT_CONFIG_PATH, SETTINGS_PATH),
  );
  const agentListSection = agents.length > 0 ? formatAgentListSection(agents) : null;

  pi.registerTool<typeof spawnAgentSchema, SubagentDetails>({
    name: "spawn-agent",
    label: "spawn-agent",
    description: [
      "Delegate a task to a subagent running in a separate pi process with an isolated context window.",
      "The `agent` parameter must be one of the available subagent types listed in the system prompt.",
      `Subagents run read-only (${DEFAULT_TOOLS.join(", ")}) unless the agent declares an explicit toolset.`,
    ].join(" "),
    promptGuidelines: agentListSection ? [agentListSection] : undefined,
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
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
          isError: true,
        };
      }

      const result = await runAgent(
        agent,
        params.task,
        ctx.cwd,
        signal,
        onUpdate,
        ctx.hasUI ? ctx.ui : undefined,
      );

      const isError =
        result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
      if (isError) {
        const { reason, message } = formatSubagentError(result);
        return {
          content: [
            { type: "text", text: `Subagent "${result.agent}" failed (${reason}):\n${message}` },
          ],
          details: {
            ...result,
            pendant: {
              markdown: formatPendantMarkdown(params.task, message),
            } satisfies ToolPendant,
          },
          isError: true,
        };
      }

      const output = getFinalOutput(result.messages) || "(no output)";
      const truncation = truncateTail(output, { maxBytes: MAX_OUTPUT_BYTES });
      const text = truncation.truncated
        ? `${truncation.content}\n\n[Output truncated to ${formatTokens(truncation.content.length)} bytes. Full result preserved in tool details.]`
        : output;
      return {
        content: [{ type: "text", text }],
        details: {
          ...result,
          pendant: {
            markdown: formatPendantMarkdown(params.task, text),
          } satisfies ToolPendant,
        },
      };
    },

    renderCall(args, theme) {
      const preview = args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task;
      const line =
        theme.fg("toolTitle", theme.bold("spawn_agent ")) + theme.fg("accent", args.agent);
      const detail = `  ${theme.fg("dim", preview)}`;
      return {
        render: (width: number) =>
          truncateToVisualLines(`${line}\n${detail}`, 2, width).visualLines,
        invalidate: (): void => undefined,
      };
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

      const lines: string[] = [];
      let header = `${icon} ${theme.fg("toolTitle", theme.bold(details.agent))}`;
      if (details.stopReason) header += ` ${theme.fg("error", `[${details.stopReason}]`)}`;
      lines.push(header);
      if (isError && details.errorMessage) {
        lines.push(theme.fg("error", `Error: ${details.errorMessage}`));
      }
      if (expanded) {
        lines.push("", theme.fg("muted", "─── Task ───"), theme.fg("dim", details.task));
        if (finalOutput) {
          lines.push("", theme.fg("muted", "─── Output ───"), finalOutput.trim());
        }
      } else if (finalOutput) {
        lines.push(theme.fg("toolOutput", finalOutput.split("\n").slice(0, 5).join("\n")));
      } else {
        lines.push(theme.fg("muted", "(no output)"));
      }
      if (usageStr) lines.push(theme.fg("dim", usageStr));
      return {
        render: (width: number) =>
          truncateToVisualLines(lines.join("\n"), Infinity, width).visualLines,
        invalidate: (): void => undefined,
      };
    },
  });
}
