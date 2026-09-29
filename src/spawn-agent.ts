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
 * `onUpdate`, the same channel the built-in bash tool uses for live output, and
 * is throttled like the bash tool: pushes are capped at one per
 * `PROGRESS_UPDATE_THROTTLE_MS` so a burst of thinking deltas does not
 * re-render the panel per chunk, and the trailing push still delivers the
 * latest state at the end of the window.
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

import { join } from "node:path";

import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionUIContext,
  getAgentDir,
  ModelRuntime,
  type PromptOptions,
  SessionManager,
  SettingsManager,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { throttle } from "lodash-es";
import { Type } from "typebox";

import { type BwrapConfig, completeBwrapConfig } from "./bwrap/core.js";
import { createClaudeCodeFileTools } from "./claude-code/files.js";
import { type ToolPendant } from "./lib/pendant.js";
import type { ToolBus } from "./lib/tool-bus.js";
import { createToolRegistration, registerToolsOnSessionStart } from "./lib/tool-registration.js";
import { createToolServices } from "./lib/tool-services.js";
import { toolsetsForToolNames, unitsForToolNames } from "./lib/tool-units.js";
import { createOpencodeFileTools } from "./opencode/files.js";
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
 * 进度推送的最小间隔（对齐 bash 工具的进度限流）:逐 chunk 的 thinking 增量
 * 会让面板每个 chunk 都重渲染一次。配合 trailing,窗口结束时的最新状态仍会送达。
 */
export const PROGRESS_UPDATE_THROTTLE_MS = 100;
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
 * 子代理的工具由 `subagentToolsExtension` 的 inline 工厂注册：它按 frontmatter
 * 声明的工具名从 `TOOL_UNITS` 里挑出覆盖到的单元（见 src/lib/tool-units.ts），
 * 与主入口共用同一张表，因此实现、审批与参数完全一致。
 *
 * 不用 `-e` 路径加载的原因：路径加载是「一个模块一份模块图」，子代理里没有
 * 任何东西能看到完整工具集（工具之间互相看不见），而且 per-agent 的沙箱配置
 * 没有注入通道——inline 工厂的闭包是 SDK 提供的唯一注入点。
 *
 * 未声明 `tools` 时子 agent 用 DEFAULT_TOOLS（只读）。
 */
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
 * 子代理的工具扩展：一个 inline 工厂里建一份注册上下文与共享服务，只注册被
 * 声明工具覆盖到的单元。
 *
 * 为什么不用 `-e` 路径加载：路径加载是「一个模块一份模块图」，子代理里没有
 * 任何东西能看到完整工具集（工具之间、脚本工具与工具之间互相看不见），而且
 * per-agent 的沙箱配置没有注入通道。inline 工厂是 pi SDK 提供的唯一注入点。
 *
 * 沙箱配置随闭包携带该 agent 的完整配置（frontmatter `sandbox`，已在
 * discoverAgents 补全成 BwrapConfig），未声明时用 SUBAGENT_DEFAULT_SANDBOX。
 */
export function subagentToolsExtension(
  agent: AgentConfig,
  tools: readonly string[],
): ExtensionFactory {
  return (pi) => {
    const registration = createToolRegistration(pi);
    const services = createToolServices(pi, { sandbox: agent.sandbox ?? SUBAGENT_DEFAULT_SANDBOX });
    const kind = toolsetsForToolNames(tools);
    if (!kind) {
      return;
    }

    const fileToolset =
      kind === "claude-code"
        ? createClaudeCodeFileTools(pi, {
            policy: services.policy,
            bus: registration.bus,
            manager: services.manager,
          })
        : createOpencodeFileTools(pi, {
            policy: services.policy,
            bus: registration.bus,
            manager: services.manager,
          });
    services.setLspEnabledHandler((service) => fileToolset.onLspEnabled(registration.bus, service));

    const units = unitsForToolNames(kind, tools);
    // 工具在 session_start 里注册：禁用规则可以带 models，而子代理的模型在扩展
    // 加载期还读不到。
    registration.onSessionStart((bus, ctx) => {
      fileToolset.restoreReads(ctx);
      for (const unit of units) {
        unit.register({
          pi,
          bus,
          policy: services.policy,
          runtime: services.runtime,
          fileToolset,
        });
      }
    });
  };
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
 * resource loader with no extensions except our own inline tool factory
 * (equivalent to --no-extensions), and the parent UI bound directly so
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
    extensionFactories: [subagentToolsExtension(agent, tools)],
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

  const emitUpdate = throttle(
    () => {
      onUpdate?.({
        content: [{ type: "text", text: progress.render(result.usage, result.model) }],
        details: {},
      });
    },
    PROGRESS_UPDATE_THROTTLE_MS,
    { trailing: true },
  );

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

/** spawn-agent 工具集：入口从它取注册函数。 */
export function createSpawnAgentTool(): { register(bus: ToolBus): void } {
  // Discover the available subagent types once at extension startup. The
  // extension owns this discovery: the model never has to guess agent names
  // or read the agent directory itself. Editing ~/.pi/agent/agents/*.md or
  // ~/.pi/agent/spawn-agent.json requires /reload to take effect.
  const agents = applyAgentDefaults(
    discoverAgents(),
    loadSpawnAgentConfig(SPAWN_AGENT_CONFIG_PATH, SETTINGS_PATH),
  );
  const agentListSection = agents.length > 0 ? formatAgentListSection(agents) : null;

  return {
    register(bus) {
      bus.register<typeof spawnAgentSchema, SubagentDetails>({
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
            result.exitCode !== 0 ||
            result.stopReason === "error" ||
            result.stopReason === "aborted";
          if (isError) {
            const { reason, message } = formatSubagentError(result);
            return {
              content: [
                {
                  type: "text",
                  text: `Subagent "${result.agent}" failed (${reason}):\n${message}`,
                },
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
    },
  };
}

export default function spawnAgent(pi: ExtensionAPI): void {
  // Windows 上禁用：子代理的工具集依赖 POSIX 设施（opencode bash 的
  // bwrap 沙箱、信号处理），不做 Windows 适配。
  if (process.platform === "win32") {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("spawn-agent is disabled on Windows.", "warning");
    });
    return;
  }

  const tools = createSpawnAgentTool();
  // 工具在 session_start 里注册：禁用规则可以带 models，只有那时才知道本会话
  // 的模型。
  registerToolsOnSessionStart(pi, (bus) => {
    tools.register(bus);
  });
}
