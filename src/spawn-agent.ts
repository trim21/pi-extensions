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
 * Progress is a rolling log: `tool: <name>` lines for tool calls and
 * `text: <content>` lines for completed text blocks, keeping the last
 * `MAX_PROGRESS_LINES` lines. Consecutive tool calls are merged into a
 * single `tool:` line (`read x 2, glob`), so a burst of tool calls does
 * not flood the window; any text block starts a new line.
 *
 * Security default: without an explicit `tools:` in the frontmatter, the
 * subagent only gets read-only tools (read/grep/find/ls) — no bash/write/edit.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionUIContext,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  truncateTail,
  truncateToVisualLines,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type AgentConfig, discoverAgents, formatAgentList } from "./spawn-agent-agents.js";

// ── constants ────────────────────────────────────────────────────────────────

/** Subagent output returned to the parent model is capped at 50KB. */
const MAX_OUTPUT_BYTES = 50 * 1024;
/** Read-only toolset used when an agent does not declare `tools`. */
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
/** Progress log keeps only the most recent lines (rolling window). */
const MAX_PROGRESS_LINES = 5;

/**
 * Tool → extension override map: when a subagent's frontmatter enables a
 * built-in tool, the matching opencode extension is loaded via `-e` so the
 * subagent uses the enhanced implementation instead of the built-in one.
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
 * implementation file (they share a read-snapshot state); the `--tools`
 * allowlist still exposes only the declared subset.
 */
const TOOL_EXTENSION_OVERRIDES: Record<string, string> = {
  read: "opencode/read.ts",
  edit: "opencode/edit.ts",
  write: "opencode/write.ts",
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
  messages: AgentMessage[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
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

/**
 * Resolve a sibling extension file (relative to this module) to an absolute
 * path, so `-e` works both when running from the source tree and from an
 * installed pi package (node_modules). A missing extension is fatal: silently
 * skipping a guard (e.g. bwrap) would leave the subagent unprotected.
 */
function extensionPath(fileName: string): string {
  const abs = fileURLToPath(new URL(fileName, import.meta.url));
  if (!existsSync(abs)) {
    throw new Error(`Extension file not found: ${abs}`);
  }
  return abs;
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
  _task: string,
  systemPromptPath: string | undefined,
): string[] {
  // RPC mode emits agent and extension UI events as JSON lines and accepts
  // dialog responses over stdin. --no-session keeps the child ephemeral.
  // --no-extensions disables
  // extension discovery; only the extensions explicitly loaded below (the
  // per-tool overrides) run inside the subagent.
  const args: string[] = ["--mode", "rpc", "--no-session", "--no-extensions"];

  // Thinking level rides on the model shorthand ("model:level"); it cannot be
  // set without a model, so a level without a model is ignored.
  const model =
    agent.model !== undefined && agent.thinkingLevel !== undefined
      ? `${agent.model}:${agent.thinkingLevel}`
      : agent.model;
  if (model) args.push("--model", model);
  // Read-only default unless the agent explicitly declares a toolset.
  const tools = agent.tools ?? DEFAULT_TOOLS;
  // Load the opencode override for each built-in tool the agent declares
  // (read/edit/write), so the subagent uses the enhanced implementation
  // instead of the built-in one. Several tool names can map to the same
  // implementation file (e.g. cc Read/Edit/Write → claude-code/files.ts);
  // loading a file twice would run its extension factory twice and create
  // separate closure states, so each file is loaded at most once.
  const loadedOverrideFiles = new Set<string>();
  for (const tool of tools) {
    const ext = TOOL_EXTENSION_OVERRIDES[tool];
    if (ext && !loadedOverrideFiles.has(ext)) {
      loadedOverrideFiles.add(ext);
      args.push("-e", extensionPath(ext));
    }
  }
  args.push("--tools", tools.join(","));
  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  return args;
}

// ── subagent runner ──────────────────────────────────────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function dialogOptions(signal: AbortSignal | undefined, timeout: number | undefined) {
  return {
    ...(signal && { signal }),
    ...(timeout !== undefined && { timeout }),
  };
}

/** Forward one RPC extension UI request to the parent session. */
export async function forwardSubagentUIRequest(
  request: RpcExtensionUIRequest,
  ui: ExtensionUIContext,
  signal?: AbortSignal,
): Promise<RpcExtensionUIResponse | undefined> {
  switch (request.method) {
    case "select": {
      const value = await ui.select(
        request.title,
        request.options,
        dialogOptions(signal, request.timeout),
      );
      return value === undefined
        ? { type: "extension_ui_response", id: request.id, cancelled: true }
        : { type: "extension_ui_response", id: request.id, value };
    }
    case "confirm": {
      const confirmed = await ui.confirm(
        request.title,
        request.message,
        dialogOptions(signal, request.timeout),
      );
      return { type: "extension_ui_response", id: request.id, confirmed };
    }
    case "input": {
      const value = await ui.input(
        request.title,
        request.placeholder,
        dialogOptions(signal, request.timeout),
      );
      return value === undefined
        ? { type: "extension_ui_response", id: request.id, cancelled: true }
        : { type: "extension_ui_response", id: request.id, value };
    }
    case "editor": {
      const value = await ui.editor(request.title, request.prefill);
      return value === undefined
        ? { type: "extension_ui_response", id: request.id, cancelled: true }
        : { type: "extension_ui_response", id: request.id, value };
    }
    case "notify": {
      ui.notify(request.message, request.notifyType);
      return undefined;
    }
    case "setStatus": {
      ui.setStatus(request.statusKey, request.statusText);
      return undefined;
    }
    case "setWidget": {
      ui.setWidget(request.widgetKey, request.widgetLines, {
        placement: request.widgetPlacement,
      });
      return undefined;
    }
    case "setTitle": {
      ui.setTitle(request.title);
      return undefined;
    }
    case "set_editor_text": {
      ui.setEditorText(request.text);
      return undefined;
    }
  }
}

export async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  parentUI?: ExtensionUIContext,
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
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let logLines: string[] = [];
    // 工具调用行合并:连续的 tool_execution_start 事件合并在同一 `tool:` 行
    // (如 `tool: read x 2, glob`),相同工具名连续出现时计为 `name x N`,
    // 不同名按调用顺序罗列;任何非工具行都会打断合并。
    let toolLineSegments: string[] = [];
    let toolLine: { name: string; count: number } | undefined;

    const toolSegment = (name: string, count: number) => (count > 1 ? `${name} x ${count}` : name);

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
      const line = `tool: ${[...toolLineSegments, toolSegment(toolLine.name, toolLine.count)].join(", ")}`;
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

    let buffer = "";

    const sendRpc = (message: object) => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    };

    let requestedShutdown = false;
    const requestShutdown = () => {
      if (requestedShutdown) return;
      requestedShutdown = true;
      proc.stdin.end();
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      const record = parseJsonRecord(line);
      if (!record) return;

      if (record.type === "extension_ui_request") {
        const request = record as RpcExtensionUIRequest;
        if (!parentUI) {
          if (
            request.method === "select" ||
            request.method === "confirm" ||
            request.method === "input" ||
            request.method === "editor"
          ) {
            sendRpc({ type: "extension_ui_response", id: request.id, cancelled: true });
          }
          return;
        }
        void forwardSubagentUIRequest(request, parentUI, signal)
          .then((response) => {
            if (response) sendRpc(response);
            return;
          })
          .catch(() => {
            sendRpc({ type: "extension_ui_response", id: request.id, cancelled: true });
          });
        return;
      }

      if (record.type === "response") {
        if (record.command === "prompt" && record.success === false) {
          result.errorMessage =
            typeof record.error === "string" ? record.error : "Subagent prompt was rejected";
          result.stopReason = "error";
          requestShutdown();
        }
        return;
      }

      const event = record as AgentSessionEvent;

      switch (event.type) {
        case "message_update": {
          // A completed text block (text_end carries the full content) becomes a
          // `text:` log line. Deltas/thinking are intentionally not logged.
          const delta = event.assistantMessageEvent;
          if (delta.type === "text_end") {
            pushLogLine(`text: ${delta.content}`);
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
            result.usage.input += msg.usage.input;
            result.usage.output += msg.usage.output;
            result.usage.cacheRead += msg.usage.cacheRead;
            result.usage.cacheWrite += msg.usage.cacheWrite;
            result.usage.cost += msg.usage.cost.total;
            result.usage.contextTokens = msg.usage.totalTokens;
            if (!result.model) result.model = msg.model;
            result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          }
          emitUpdate();

          break;
        }
        case "agent_settled": {
          requestShutdown();
          break;
        }
        // No default
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

    proc.stdin.on("error", (error) => {
      if (!requestedShutdown) result.stderr += error.message;
    });

    sendRpc({ type: "prompt", message: `Task: ${task}` });

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

/**
 * Parse one line of the subagent's RPC stream into a JSON object. Non-JSON
 * lines and records without a type discriminator are rejected.
 */
function parseJsonRecord(line: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  if (typeof (raw as Record<string, unknown>).type !== "string") return null;
  return raw as Record<string, unknown>;
}

/** Session entry customType used to mark the injected subagent list. */
export function formatAgentListSection(agents: AgentConfig[]): string {
  const lines = agents.map((a) => `- \`${a.name}\`: ${a.description}`);
  return [
    "## Available subagents",
    "",
    "You can delegate tasks to the following subagent types by calling the `spawn-agent` tool with their name in the `agent` parameter:",
    "",
    ...lines,
  ].join("\n");
}

// ── extension ────────────────────────────────────────────────────────────────

export default function spawnAgent(pi: ExtensionAPI) {
  // Windows 上禁用：子代理进程的派生（node/bun 运行时下回退到 `pi` 命令，
  // 而 npm 安装的 pi 是 .cmd shim，spawn 无法直接启动）与信号管理都是
  // POSIX 假设，不做 Windows 适配。
  if (process.platform === "win32") {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("spawn-agent is disabled on Windows.", "warning");
    });
    return;
  }

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
    name: "spawn-agent",
    label: "spawn-agent",
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
