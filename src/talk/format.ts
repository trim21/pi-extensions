/**
 * The exact strings the model (and user) read. These are the interface —
 * pinned by tests; change them deliberately.
 */

import type { Letter } from "./mailbox.js";
import type { AgentRecord, Presence } from "./registry.js";

export const BOUNDARY_PREAMBLE = "This came from another pi agent, not from the user.";

export function shortAddr(addr: string): string {
  return addr.slice(0, 6);
}

export function age(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Delivery text injected into the receiving agent's LLM context. */
export function formatDelivery(letter: Letter, now: number = Date.now()): string {
  const from = letter.from;
  const header = `From pi agent ${from.agentId} (${from.cwd}) — "${from.name}"`;
  const meta = `_id ${letter.id} · ${letter.kind} · sent ${age(letter.ts, now)}_`;
  const hint =
    letter.kind === "ask" ? `\n\nReply with the talk-reply tool, replyTo: "${letter.id}"` : "";
  return `${BOUNDARY_PREAMBLE}\n\n${header}:\n\n${letter.body}\n\n${meta}${hint}`;
}

/** One agent as the model sees it in a listing. `id` is the stable pi
 * agent uuid; `name` is the display name when one was set; `self` marks
 * the calling agent itself. */
export interface AgentListItem {
  status: string;
  work_dir: string;
  id: string;
  name?: string;
  self?: boolean;
}

/** Machine-readable JSON listing of agents (what the model sees). */
export function formatListing(
  records: AgentRecord[],
  selfAddr: string,
  presence: (r: AgentRecord) => Presence,
): string {
  if (records.length === 0) return "[]";
  const items: AgentListItem[] = records.map((r) => {
    const p = presence(r);
    const status = p === "live" ? r.status : "offline";
    const item: AgentListItem = { status, work_dir: r.cwd, id: r.agentId, name: r.name };
    if (r.addr === selfAddr) item.self = true;
    return item;
  });
  return JSON.stringify(items, null, 2);
}

export function refusalUnknown(to: string): string {
  return `Unknown agent id '${to}'. Get agent ids with talk-list-agents.`;
}
