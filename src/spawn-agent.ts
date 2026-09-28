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
 * `text: <content>` lines for completed text blocks, keeping only the last few
 * lines (`MAX_PROGRESS_LINES` in spawn-agent-progress.ts). Consecutive tool calls are merged into a
 * single `tool:` line (`read x 2, glob`) and over-long line content is
 * folded to the first/last 9 chars joined by `…`, so a burst of tool calls
 * or a long text block does not flood the window; only a text block starts
 * a new line — thinking is a transient status line, so it does not break the
 * merge across turn boundaries. Line content is sanitized first: markdown
 * marker characters are stripped and whitespace (including newlines) is
 * collapsed to single spaces,
 * so one log entry is always exactly one rendered line. The final line is
 * always the subagent name as a code span (`` `scout` ``), followed by the
 * live usage stats when there are any; it rides outside the rolling window so
 * it is never trimmed. The model name on that line is the model the session
 * actually uses, which differs from the frontmatter string when the declared
 * model resolved to nothing and the SDK fell back to a default. While the
 * model is thinking, a transient
 * `thinking ( N chars )` line sits between the log and the footer showing the
 * live character count of the streamed thinking; it disappears when the
 * thinking block ends.
 *
 * Security default: without an explicit `tools:` in the frontmatter, the
 * subagent only gets read-only tools (read/grep/find/ls) — no bash/write/edit.
 * A frontmatter `sandbox:` gives the bash tool a fixed bwrap sandbox config
 * (sandbox.json shape, e.g. fs.mode readonly): it is passed to the subagent's
 * bwrap runtime as the complete config, unsandboxed execution requests are
 * refused, and /bwrap-* commands are not registered (see spawn-agent-agents.ts).
 * Without `sandbox:` the bash tool gets SUBAGENT_DEFAULT_SANDBOX (readonly fs,
 * blocked network) with the same fixed-sandbox semantics: subagents never
 * inherit the user's sandbox.json, whose modes may be relaxed for interactive use.
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
  type InlineExtension,
  ModelRuntime,
  type PromptOptions,
  SessionManager,
  SettingsManager,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type BwrapConfig, completeBwrapConfig } from "./bwrap/core.js";
import { type BwrapRuntime, createBwrapRuntime } from "./bwrap/runtime.js";
import { registerShellTools } from "./claude-code/shell.js";
import { type ToolPendant } from "./lib/pendant.js";
import { createRequestPolicy } from "./lib/request-policy.js";
import opencodeBash from "./opencode/bash.js";
import {
  type AgentConfig,
  applyAgentDefaults,
  discoverAgents,
  formatAgentList,
  loadSpawnAgentConfig,
} from "./spawn-agent-agents.js";
import { createSubagentProgress, formatTokens } from "./spawn-agent-progress.js";

// ── constants ────────────────────────────────────────────────────────────────

/** Subagent output returned to the parent model is capped at 50KB. */
const MAX_OUTPUT_BYTES = 50 * 1024;
/** Read-only toolset used when an agent does not declare `tools`. */
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
/**
 * 子代理未在 frontmatter 声明 `sandbox` 时 bash 使用的固定沙箱：文件系统只读 + 断网。
 * 与主会话（跟随用户 sandbox.json）相反，子代理不继承用户配置——为交互会话放宽的
 * 模式不应被自动委派的任务顺带复用；要写工作区或联网的 agent 必须在 frontmatter 里
 * 显式声明自己的 sandbox。
 */
export const SUBAGENT_DEFAULT_SANDBOX: BwrapConfig = completeBwrapConfig({
  fs: { mode: "readonly" },
  network: { mode: "block" },
});
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
 * `bash` (opencode) and `Bash` (claude-code) are deliberately not in this map:
 * they are injected via an inline extension factory (subagentShellExtension)
 * instead, because their bwrap runtime carries the agent's declared sandbox
 * config — a path-based override has no channel to pass per-agent config
 * (see createSubagentSession).
 * (Workspace write protection is embedded in the opencode write/edit tools.)
 *
 * Claude Code style tools (capitalized names) map to their claude-code
 * files, so a subagent can enable exactly the tools it declares — e.g. `Grep`
 * without `Glob`. The stateful file tools (`Read`/`Edit`/`Write`) share one
 * implementation file (they share a read-snapshot state); the `tools`
 * allowlist still exposes only the declared subset. The opencode file tools
 * (read/edit/write) likewise share opencode/files.ts (they share the LSP
 * service instance); that file also registers the shared `lsp-rename` and
 * LSP inspect tools, which stay hidden unless a subagent declares them.
 *
 * The lowercase search tools map to the opencode implementations: `grep`
 * overrides pi's built-in grep, and `glob` adds a tool pi has no built-in for
 * (its `find` stays available). Each is a self-contained file registering one
 * tool, so they load independently — `grep` without `glob`.
 */
const TOOL_EXTENSION_OVERRIDES: Record<string, string> = {
  read: "opencode/files.ts",
  edit: "opencode/files.ts",
  write: "opencode/files.ts",
  grep: "opencode/grep.ts",
  glob: "opencode/glob.ts",
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

/** 子 agent 的一次运行结果：runAgent 的返回值。 */
interface SubagentResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: AgentMessage[];
  stderr: string;
  usage: UsageStats;
  /** 实际生效的模型 id（fallback 之后），不是 frontmatter 里写的名字。 */
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface SubagentDetails {
  /** 折叠 markdown 面板：父 agent 的 prompt 与父 agent 看到的子 agent 结果。 */
  pendant?: ToolPendant;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function getFinalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") {
          return part.text;
        }
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
export function formatSubagentError(result: SubagentResult): { reason: string; message: string } {
  const reason =
    result.stopReason ?? (result.exitCode === 0 ? "failed" : `exit ${result.exitCode}`);
  const parts: string[] = [];
  if (result.errorMessage) {
    parts.push(`error: ${result.errorMessage}`);
  }
  const stderr = truncateTail(result.stderr, { maxBytes: MAX_STDERR_ERROR_BYTES });
  if (stderr.content.trim()) {
    const truncatedMark = stderr.truncated ? "\n[stderr truncated]" : "";
    parts.push(`stderr: ${stderr.content.trim()}${truncatedMark}`);
  }
  const output = getFinalOutput(result.messages);
  if (output) {
    parts.push(`output: ${output}`);
  }
  return { reason, message: parts.length > 0 ? parts.join("\n") : "(no output)" };
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
    if (!ext || loaded.has(ext)) {
      continue;
    }

    loaded.add(ext);
    paths.push(extensionPath(ext));
  }
  return paths;
}

/**
 * bash 类工具（opencode `bash` / cc `Bash`）的内联扩展工厂：bwrap runtime 随闭包
 * 携带该 agent 的完整沙箱配置（frontmatter `sandbox`，已在 discoverAgents 补全成
 * BwrapConfig），未声明时用 SUBAGENT_DEFAULT_SANDBOX。路径式 override
 * （additionalExtensionPaths）没有 per-agent 配置通道，extensionFactories 的工厂
 * 闭包是 SDK 提供的唯一注入点。
 */
export function subagentShellExtension(
  agent: AgentConfig,
  register: (pi: ExtensionAPI, runtime: BwrapRuntime) => void,
): InlineExtension {
  return (pi) =>
    register(
      pi,
      createBwrapRuntime(createRequestPolicy(pi.events), agent.sandbox ?? SUBAGENT_DEFAULT_SANDBOX),
    );
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
  if (!agent.model) {
    return undefined;
  }
  const slash = agent.model.indexOf("/");
  if (slash > 0) {
    return modelRuntime.getModel(agent.model.slice(0, slash), agent.model.slice(slash + 1));
  }
  if (agent.provider) {
    return modelRuntime.getModel(agent.provider, agent.model);
  }
  const defaultProvider = settingsManager.getDefaultProvider();
  return defaultProvider ? modelRuntime.getModel(defaultProvider, agent.model) : undefined;
}

// ── subagent runner ──────────────────────────────────────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** The subset of AgentSession runAgent relies on (injectable for tests). */
export interface SubagentSession {
  agent: { state: { messages: AgentMessage[] } };
  /**
   * Model the session actually runs (after any SDK fallback), shown in the
   * progress footer. Optional: injected test sessions need not expose it.
   */
  model?: { id: string };
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
  const tools = agent.tools ?? DEFAULT_TOOLS;
  const settingsManager = SettingsManager.create(cwd, getAgentDir());
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: overrideExtensionPaths(tools),
    extensionFactories: [
      ...(tools.includes("bash") ? [subagentShellExtension(agent, opencodeBash)] : []),
      ...(tools.includes("Bash") ? [subagentShellExtension(agent, registerShellTools)] : []),
    ],
    appendSystemPrompt: agent.systemPrompt ? [agent.systemPrompt] : undefined,
  });
  await loader.reload();

  const modelRuntime = await ModelRuntime.create();
  const { session } = await createAgentSession({
    cwd,
    model: resolveModel(modelRuntime, agent, settingsManager),
    thinkingLevel: agent.thinkingLevel,
    tools,
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
): Promise<SubagentResult> {
  const result: SubagentResult = {
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

  // 面板显示实际生效的模型：frontmatter 里的模型名解析不到时，SDK 会静默
  // fallback 到默认模型，回显配置原文会掩盖这次 fallback。
  result.model = session.model?.id;

  const progress = createSubagentProgress({ name: result.agent });

  const emitUpdate = () => {
    onUpdate?.({
      content: [{ type: "text", text: progress.render(result.usage, result.model) }],
      details: {},
    });
  };

  const handleEvent = (event: AgentSessionEvent) => {
    switch (event.type) {
      case "message_update": {
        // A completed text block (text_end carries the full content) becomes a
        // `text:` log line. Deltas are intentionally not logged; thinking
        // deltas feed the transient `thinking ( N chars )` status line instead.
        const delta = event.assistantMessageEvent;
        switch (delta.type) {
          case "text_end": {
            progress.noteTextBlock(delta.content);
            emitUpdate();
            break;
          }
          case "thinking_start": {
            // thinking 不产生日志行，因此不打断工具行合并：跨轮次的连续工具调用
            // 仍累加到同一 `tool:` 行。
            progress.thinkingStart();
            emitUpdate();
            break;
          }
          case "thinking_delta": {
            progress.thinkingDelta(delta.delta.length);
            emitUpdate();
            break;
          }
          case "thinking_end": {
            progress.thinkingEnd();
            emitUpdate();
            break;
          }
          // No default
        }

        break;
      }
      case "tool_execution_start": {
        progress.noteToolCall(event.toolName);
        emitUpdate();
        break;
      }
      case "message_end": {
        const msg = event.message;
        result.messages.push(msg);
        if (msg.role === "assistant") {
          result.usage.turns++;
          result.usage.cost += msg.usage.cost.total;
          result.usage.contextTokens = msg.usage.totalTokens;
          if (!result.model) {
            result.model = msg.model;
          }
          result.stopReason = msg.stopReason;
          if (msg.errorMessage) {
            result.errorMessage = msg.errorMessage;
          }
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
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
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
      "Delegate a task to a subagent that runs in an isolated session with its own context window, inside this pi process rather than a separate one.",
      "The call blocks until the subagent finishes its turn; its final output comes back as the tool result.",
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
          details: {},
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
            pendant: {
              subtitle: result.agent,
              markdown: formatPendantMarkdown(params.task, message),
            } satisfies ToolPendant,
          },
          isError: true,
        };
      }

      const output = getFinalOutput(result.messages) || "(no output)";
      const truncation = truncateTail(output, { maxBytes: MAX_OUTPUT_BYTES });
      const text = truncation.truncated
        ? `${truncation.content}\n\n[Output truncated to ${formatTokens(truncation.content.length)} bytes.]`
        : output;
      return {
        content: [{ type: "text", text }],
        details: {
          pendant: {
            subtitle: result.agent,
            markdown: formatPendantMarkdown(params.task, text),
          } satisfies ToolPendant,
        },
      };
    },
  });
}
