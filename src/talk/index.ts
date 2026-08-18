/**
 * pi adapter for the talk core: owns the pi API surface.
 *
 * The core layer (core.ts) is pi-free and drives all talk behavior through a
 * TalkStorage backend; this file only:
 * - wires pi lifecycle events to the core,
 * - turns core deliveries/notifications into pi.sendMessage,
 * - registers the talk tools, the /talk command, and the delivery renderer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";

import { type CommandResult, type CommandSpec, parseCommand } from "../lib/cli.js";
import { resolveHomePath } from "../lib/path.js";
import { TalkCore } from "./core.js";
import { formatDelivery } from "./format.js";
import type { Letter } from "./mailbox.js";
import { type AgentRecord, deriveAddr } from "./registry.js";
import { SqliteTalkStorage } from "./storage.js";

const DELIVERY_TYPE = "talk:delivery";
const LIST_TYPE = "talk:list";
const NOTIFY_TYPE = "talk:notify";

const ASK_TIMEOUT_MS = 30 * 60 * 1000;

/** Guide the model to the multi-agent workflow skill shipped with this package. */
const SKILL_PATH = fileURLToPath(new URL("skills/multi-agent-dev/SKILL.md", import.meta.url));

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

// ── TUI presentation helpers ─────────────────────────────────────────────

/** Strip peer-supplied ANSI escapes/control chars before they reach the terminal. */
function sanitizeTerminal(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- intentionally strips CSI sequences
      .replaceAll(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex -- intentionally strips OSC sequences
      .replaceAll(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?/g, "")
      // eslint-disable-next-line no-control-regex -- intentionally strips C0 controls (keeps \n \t)
      .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  );
}

/** One-line display name, length-capped. */
function displayName(name: string): string {
  return sanitizeTerminal(name.replaceAll(/\s+/g, " ")).slice(0, 40);
}

/** Collapse $HOME to ~ for display. */
function shortCwd(cwd: string): string {
  const home = os.homedir();
  const display =
    cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
  return sanitizeTerminal(display);
}

function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Presentation metadata for a delivery. `details` is never sent to the LLM. */
interface DeliveryDetails {
  id: string;
  kind: Letter["kind"];
  from: Letter["from"];
  ts: number;
  body: string;
  replyTo?: string;
}

/**
 * Read the default sqlite path and delivery mode from global settings.json:
 * `{ "talk": { "db_path": "...", "deliver": "steer" | "queue" } }`.
 */
function readTalkSettings(): { dbPath?: string; deliver?: "steer" | "queue" } {
  try {
    const raw = fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { talk?: { db_path?: unknown; deliver?: unknown } };
    const talk = parsed.talk;
    if (!talk) return {};
    const dbPath = typeof talk.db_path === "string" ? talk.db_path : undefined;
    const deliver = talk.deliver === "steer" || talk.deliver === "queue" ? talk.deliver : undefined;
    return { dbPath, deliver };
  } catch {
    return {};
  }
}

export default function talk(pi: ExtensionAPI) {
  const settings = readTalkSettings();
  const configured = process.env.PI_TALK_DB ?? settings.dbPath;
  const dbPath = configured
    ? resolveHomePath(configured, getAgentDir())
    : path.join(getAgentDir(), "talk.db");
  // "queue": deliver on the agent's next natural turn without waking it;
  // "steer": interrupt mid-run / wake an idle agent immediately.
  const deliverMode: "steer" | "queue" = settings.deliver ?? "queue";
  const storage = new SqliteTalkStorage(dbPath);

  let self: AgentRecord | undefined;
  /** Display name explicitly set via `--name`; kept across session_info_changed. */
  let explicitName: string | undefined;

  function deliverToAgent(letter: Letter): boolean {
    const details: DeliveryDetails = {
      id: letter.id,
      kind: letter.kind,
      from: letter.from,
      ts: letter.ts,
      body: letter.body,
      ...(letter.replyTo !== undefined && { replyTo: letter.replyTo }),
    };
    try {
      // The core only removes the letter from the inbox after this returns
      // true, so a failure keeps it queued for a later poll.
      pi.sendMessage(
        { customType: DELIVERY_TYPE, content: formatDelivery(letter), display: true, details },
        deliverMode === "steer"
          ? { triggerTurn: true, deliverAs: "steer" }
          : { deliverAs: "nextTurn" },
      );
      return true;
    } catch {
      return false;
    }
  }

  const core = new TalkCore({
    storage,
    events: {
      deliver: deliverToAgent,
      notify(content) {
        // Presence transitions are informational — queue for the next turn
        // rather than steering into a busy agent.
        pi.sendMessage(
          { customType: NOTIFY_TYPE, content, display: true },
          { deliverAs: "nextTurn" },
        );
      },
    },
  });

  function requireInit(): string | undefined {
    if (!core.selfAddr) return "Talk is not initialized (no session_start yet).";
    return undefined;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const agentId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd() ?? ctx.cwd;
    const now = Date.now();
    self = {
      addr: deriveAddr(cwd, agentId),
      agentId,
      name: pi.getSessionName() ?? "Unnamed agent",
      cwd,
      pid: process.pid,
      startedAt: now,
      lastSeenAt: now,
      status: "idle",
    };
    void core.start(self);
  });

  pi.on("agent_start", () => core.setWorking());
  pi.on("agent_end", () => core.setIdle());
  pi.on("agent_settled", () => core.setIdle());
  pi.on("before_agent_start", (event) => {
    // One-line nudge: before coordinating with other pi agents, read the
    // shipped workflow skill.
    return {
      systemPrompt: `${event.systemPrompt}\n\nBefore multi-agent collaboration, read ${SKILL_PATH} to understand the talk workflow.`,
    };
  });
  pi.on("session_info_changed", () => {
    // A name set explicitly via `--name` wins over pi's session title;
    // otherwise follow pi's session name.
    if (self) core.setAgentName(explicitName ?? pi.getSessionName() ?? self.name);
  });
  pi.on("session_shutdown", () => {
    void core.stop();
  });

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "talk-list-agents",
    label: "List Talk Agents",
    description: "List visible pi agents (id, status, work_dir, name).",
    promptSnippet: "List other pi agents on this machine",
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "Only list agents in this directory" })),
    }),
    async execute(_toolCallId, params) {
      const initError = requireInit();
      if (initError) return toolResult(initError);
      return toolResult(params.cwd ? await core.listCwd(params.cwd) : await core.list());
    },
  });

  pi.registerTool({
    name: "talk-ask",
    label: "Ask Talk",
    description:
      "Ask another pi agent a question and block until it replies (or times out). Before asking, it checks whether that agent already sent you something; if so, you are told to read and reply first instead of asking.",
    promptSnippet: "Ask another pi agent a question and wait for the reply",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent (name/address/@alias)" }),
      message: Type.String({ description: "The question" }),
      timeoutMs: Type.Optional(
        Type.Number({ description: `Wait cap in ms; default ${ASK_TIMEOUT_MS}` }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const initError = requireInit();
      if (initError) return toolResult(initError);
      return toolResult(
        await core.ask(
          params.to,
          params.message,
          params.timeoutMs ?? ASK_TIMEOUT_MS,
          signal ?? undefined,
        ),
      );
    },
  });

  pi.registerTool({
    name: "talk-send",
    label: "Send Talk Message",
    description:
      "Send a plain-text message to a single pi agent. Plain text only, ≤32KB — send a summary and a path, never file contents.",
    promptSnippet: "Send a message to another pi agent",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent id (from talk-list-agents)" }),
      message: Type.String({ description: "Message body" }),
    }),
    async execute(_toolCallId, params) {
      const initError = requireInit();
      if (initError) return toolResult(initError);
      return toolResult(await core.send(params.to, params.message));
    },
  });

  pi.registerTool({
    name: "talk-reply",
    label: "Reply Talk",
    description:
      "Reply to a received ask. `replyTo` is the ask/message id (shown in the delivered message).",
    promptSnippet: "Reply to a talk ask",
    parameters: Type.Object({
      replyTo: Type.String({ description: "The ask/message id to reply to" }),
      message: Type.String({ description: "The reply body" }),
    }),
    async execute(_toolCallId, params) {
      const initError = requireInit();
      if (initError) return toolResult(initError);
      return toolResult(await core.reply(params.replyTo, params.message));
    },
  });

  // ── /talk commands ────────────────────────────────────────────────────

  type OkResult<TFlags extends TObject> = Extract<CommandResult<TFlags>, { kind: "ok" }>;

  /** Parse a /talk command; on help/error or init failure the text is sent, otherwise run() produces the listing text. */
  function handleCommand<TFlags extends TObject>(
    spec: CommandSpec<TFlags>,
    args: string,
    run: (parsed: OkResult<TFlags>) => Promise<string> | string,
  ): Promise<void> {
    const parsed = parseCommand(spec, args);
    if (parsed.kind !== "ok") {
      pi.sendMessage({ customType: LIST_TYPE, content: parsed.text, display: true });
      return Promise.resolve();
    }
    return (async () => {
      const initError = requireInit();
      const text = initError ?? (await run(parsed));
      pi.sendMessage({ customType: LIST_TYPE, content: text, display: true });
    })();
  }

  const TALK_SPEC = {
    name: "talk",
    usage: "",
    description: "List registered pi agents",
    flags: Type.Object({}),
    arity: { max: 0 },
  };

  const TALK_DEAD_SPEC = {
    name: "talk-dead",
    usage: "[agentId] [options]",
    description:
      "Mark a talk agent as dead (shown offline, swept soon): no arg = this agent, <agentId> = that agent, --all = every other visible agent",
    flags: Type.Object({
      all: Type.Optional(Type.Boolean({ description: "Mark every other visible agent dead" })),
    }),
    flagMeta: { all: { short: "a" } },
    arity: { max: 1 },
  };

  const TALK_GROUP_JOIN_SPEC = {
    name: "talk-group-join",
    usage: "[group name] [options]",
    description:
      "Join or create a private agent group (members see only each other; an agent in no group sees only itself). No arg = new group with a generated uuid; <name> = join that group, or create it when it does not exist; --name <alias> additionally sets this agent's display name",
    flags: Type.Object({
      name: Type.Optional(Type.String({ description: "Set this agent's display name" })),
    }),
    flagMeta: { name: { short: "n", valuePlaceholder: "<alias>" } },
    arity: { max: 1 },
    examples: ["/talk-group-join frontend", "/talk-group-join --name frontend"],
  };

  const TALK_GROUP_JOIN_LAST_SPEC = {
    name: "talk-group-join-last",
    usage: "",
    description: "Join the most recently created agent group (no-op when already in it).",
    flags: Type.Object({}),
    arity: { max: 0 },
  };

  const TALK_GROUP_LEAVE_SPEC = {
    name: "talk-group-leave",
    usage: "",
    description: "Leave the current agent group (an emptied group is deleted).",
    flags: Type.Object({}),
    arity: { max: 0 },
  };

  const TALK_GROUP_LIST_SPEC = {
    name: "talk-group-list",
    usage: "",
    description: "List all agent groups and their members, newest first.",
    flags: Type.Object({}),
    arity: { max: 0 },
  };

  const TALK_GROUP_DEL_SPEC = {
    name: "talk-group-del",
    usage: "<group name>",
    description:
      "Delete an agent group by name; its members become ungrouped (see only themselves).",
    flags: Type.Object({}),
    arity: { min: 1, max: 1 },
  };

  const TALK_GROUP_CLEAR_SPEC = {
    name: "talk-group-clear",
    usage: "",
    description: "Delete every agent group; all agents become ungrouped.",
    flags: Type.Object({}),
    arity: { max: 0 },
  };

  pi.registerCommand("talk", {
    description: TALK_SPEC.description,
    handler: (args) => handleCommand(TALK_SPEC, args, async () => core.list()),
  });

  pi.registerCommand("talk-dead", {
    description: TALK_DEAD_SPEC.description,
    handler: (args) =>
      handleCommand(TALK_DEAD_SPEC, args, async (parsed) => {
        if (parsed.flags.all && parsed.args.length > 0) {
          return "--all cannot be combined with an agent id.\nTry '/talk-dead --help' for usage.";
        }
        return parsed.flags.all
          ? await core.markAllDead()
          : parsed.args[0]
            ? await core.markDead(parsed.args[0])
            : await core.markDead();
      }),
  });

  pi.registerCommand("talk-group-join", {
    description: TALK_GROUP_JOIN_SPEC.description,
    handler: (args) =>
      handleCommand(TALK_GROUP_JOIN_SPEC, args, async (parsed) => {
        const agentName = parsed.flags.name?.trim() || undefined;
        if (agentName !== undefined) explicitName = agentName;
        return core.groupJoin(parsed.args[0], agentName);
      }),
  });

  pi.registerCommand("talk-group-join-last", {
    description: TALK_GROUP_JOIN_LAST_SPEC.description,
    handler: (args) =>
      handleCommand(TALK_GROUP_JOIN_LAST_SPEC, args, async () => core.groupJoinLast()),
  });

  pi.registerCommand("talk-group-leave", {
    description: TALK_GROUP_LEAVE_SPEC.description,
    handler: (args) => handleCommand(TALK_GROUP_LEAVE_SPEC, args, async () => core.groupLeave()),
  });

  pi.registerCommand("talk-group-list", {
    description: TALK_GROUP_LIST_SPEC.description,
    handler: (args) => handleCommand(TALK_GROUP_LIST_SPEC, args, async () => core.groupList()),
  });

  pi.registerCommand("talk-group-del", {
    description: TALK_GROUP_DEL_SPEC.description,
    handler: (args) =>
      handleCommand(TALK_GROUP_DEL_SPEC, args, async (parsed) => core.groupDelete(parsed.args[0])),
  });

  pi.registerCommand("talk-group-clear", {
    description: TALK_GROUP_CLEAR_SPEC.description,
    handler: (args) => handleCommand(TALK_GROUP_CLEAR_SPEC, args, async () => core.groupClear()),
  });

  // ── Delivery card ──────────────────────────────────────────────────────

  pi.registerMessageRenderer<DeliveryDetails>(DELIVERY_TYPE, (message, _options, theme) => {
    const d = message.details;
    if (
      !d ||
      typeof d.id !== "string" ||
      typeof d.ts !== "number" ||
      typeof d.body !== "string" ||
      !d.from
    ) {
      return; // pre-renderer entries: keep pi's default custom-message box
    }
    const idTail = d.id.slice(-8);
    const chip = theme.inverse(` ${d.kind.toUpperCase()} `);
    const header = `${theme.fg("accent", theme.bold(displayName(d.from.name)))} ${theme.fg("dim", `(${shortCwd(d.from.cwd)})`)} ${chip}`;
    const footer = theme.fg("dim", `id ${idTail} · ${d.kind} · ${relativeTime(d.ts)}`);
    const out = [header, sanitizeTerminal(d.body), "", footer];
    if (d.kind === "ask") {
      out.push(theme.fg("dim", `└─ reply via talk-reply, replyTo: "${idTail}"`));
    }
    // plain 组件：不引入 pi-tui，直接输出带背景色的文本行
    const text = out.join("\n");
    return {
      render: (width: number) =>
        truncateToVisualLines(text, Infinity, width, 1).visualLines.map((line) =>
          theme.bg("customMessageBg", line),
        ),
      invalidate: (): void => undefined,
    };
  });
}
