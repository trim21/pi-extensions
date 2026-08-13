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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { jsoncToJson } from "../lib/jsonc.js";
import { resolveHomePath } from "../lib/path.js";
import { buildVisibilityFilter, TalkCore } from "./core.js";
import { formatDelivery } from "./format.js";
import type { Letter } from "./mailbox.js";
import { deriveAddr, type SessionRecord } from "./registry.js";
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

/**
 * Read the workspace visibility config from `<cwd>/.pi/talk.json`:
 * `{ "allowed": ["~/projects/company1/"] }`. Missing file/key → undefined
 * (everything visible); an explicit `"allowed": []` hides every peer.
 */
function readWorkspaceTalkConfig(cwd: string): { allowed?: string[] } {
  const configPath = path.join(cwd, ".pi", "talk.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(jsoncToJson(raw)) as { allowed?: unknown };
    if (Array.isArray(parsed.allowed)) {
      return { allowed: parsed.allowed.filter((p): p is string => typeof p === "string") };
    }
    return {};
  } catch (error) {
    // eslint-disable-next-line no-console -- config errors must be visible, not silent
    console.error(`Warning: could not parse ${configPath}: ${String(error)}`);
    return {};
  }
}

export default function talk(pi: ExtensionAPI) {
  const settings = readTalkSettings();
  const configured = process.env.PI_TALK_DB ?? settings.dbPath;
  const dbPath = configured
    ? resolveHomePath(configured, getAgentDir())
    : path.join(getAgentDir(), "talk.db");
  // "queue": deliver on the session's next natural turn without waking it;
  // "steer": interrupt mid-run / wake an idle session immediately.
  const deliverMode: "steer" | "queue" = settings.deliver ?? "queue";
  const storage = new SqliteTalkStorage(dbPath);

  let self: SessionRecord | undefined;

  function deliverToSession(letter: Letter): boolean {
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
      deliver: deliverToSession,
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
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd() ?? ctx.cwd;
    const now = Date.now();
    self = {
      addr: deriveAddr(cwd, sessionId),
      sessionId,
      name: pi.getSessionName() ?? "Unnamed session",
      cwd,
      pid: process.pid,
      startedAt: now,
      lastSeenAt: now,
      status: "idle",
    };
    core.setPeerVisibility(buildVisibilityFilter(readWorkspaceTalkConfig(cwd).allowed, cwd));
    void core.start(self);
  });

  pi.on("agent_start", () => core.setWorking());
  pi.on("agent_end", () => core.setIdle());
  pi.on("agent_settled", () => core.setIdle());
  pi.on("before_agent_start", (event) => {
    // One-line nudge: before coordinating with other pi sessions, read the
    // shipped workflow skill. Skipped when the skill file is absent.
    if (!fs.existsSync(SKILL_PATH)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nBefore multi-session collaboration, read ${SKILL_PATH} to understand the talk workflow.`,
    };
  });
  pi.on("session_info_changed", () => {
    if (self) core.setSessionName(pi.getSessionName() ?? self.name);
  });
  pi.on("session_shutdown", () => {
    void core.stop();
  });

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "talk-list-sessions",
    label: "List Talk Sessions",
    description:
      "List other pi sessions with a recent heartbeat (id, status, work_dir, name). Pass includeOffline to also list stale sessions.",
    promptSnippet: "List other pi sessions on this machine",
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "Only list sessions in this directory" })),
      includeOffline: Type.Optional(
        Type.Boolean({ description: "Include sessions without a recent heartbeat" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const initError = requireInit();
      if (initError) return toolResult(initError);
      const includeOffline = params.includeOffline === true;
      return toolResult(
        params.cwd
          ? await core.listCwd(params.cwd, includeOffline)
          : await core.list(includeOffline),
      );
    },
  });

  pi.registerTool({
    name: "talk-ask",
    label: "Ask Talk",
    description:
      "Ask another pi session a question and block until it replies (or times out). Before asking, it checks whether that session already sent you something; if so, you are told to read and reply first instead of asking.",
    promptSnippet: "Ask another pi session a question and wait for the reply",
    parameters: Type.Object({
      to: Type.String({ description: "Target session (name/address/@alias)" }),
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
      'Send a plain-text message to another pi session. Plain text only, ≤32KB — send a summary and a path, never file contents. `to: "*"` broadcasts to every session; `to: "cwd"` broadcasts to sessions in this cwd.',
    promptSnippet: "Send a message to another pi session",
    parameters: Type.Object({
      to: Type.String({
        description: 'Target session (name/address/@alias; "*" or "cwd" to broadcast)',
      }),
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

  pi.registerCommand("talk", {
    description: "List registered pi sessions",
    async handler() {
      const text = requireInit() ?? (await core.list());
      pi.sendMessage({ customType: LIST_TYPE, content: text, display: true });
    },
  });

  pi.registerCommand("talk-dead", {
    description:
      "Mark a talk session as dead (removed from listings, swept soon): no arg = this session, <sessionId> = that session, --all = every other visible session",
    async handler(args) {
      const initError = requireInit();
      const trimmed = args.trim();
      const text =
        initError ??
        (trimmed === "--all"
          ? await core.markAllDead()
          : trimmed
            ? await core.markDead(trimmed)
            : await core.markDead());
      pi.sendMessage({ customType: LIST_TYPE, content: text, display: true });
    },
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
    const id8 = d.id.slice(0, 8);
    const chip = theme.inverse(` ${d.kind.toUpperCase()} `);
    const header = `${theme.fg("accent", theme.bold(displayName(d.from.name)))} ${theme.fg("dim", `(${shortCwd(d.from.cwd)})`)} ${chip}`;
    const footer = theme.fg("dim", `id ${id8} · ${d.kind} · ${relativeTime(d.ts)}`);
    const out = [header, sanitizeTerminal(d.body), "", footer];
    if (d.kind === "ask") {
      out.push(theme.fg("dim", `└─ reply via talk-reply, replyTo: "${id8}"`));
    }
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(out.join("\n"), 0, 0));
    return box;
  });
}
