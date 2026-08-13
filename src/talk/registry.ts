/**
 * Session registry for the talk mailbox: who is around, where, and whether
 * they are reachable. Core layer — depends only on TalkStorage, never on pi.
 *
 * Design:
 * - An address belongs to a conversation, not a process: hash of cwd + pi
 *   session id, so a resumed session (`pi -c`) answers to the same address and
 *   two sessions on one directory never share an inbox.
 * - A record outlives the process that wrote it — that's what makes a session
 *   addressable while it's down (mail waits on disk).
 * - Presence is a pid PLUS a heartbeat: pid alone can't tell wedged from
 *   healthy (and pids get reused); heartbeat alone can't tell crash from pause.
 * - Listing has NO side effects.
 *
 * All values read from storage are validated with TypeBox before use.
 */

import { createHash } from "node:crypto";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import type { TalkStorage } from "./storage.js";

export const SessionRecordSchema = Type.Object({
  addr: Type.String(),
  sessionId: Type.String(),
  name: Type.String(),
  cwd: Type.String(),
  pid: Type.Number(),
  startedAt: Type.Number(),
  lastSeenAt: Type.Number(),
  status: Type.Union([Type.Literal("idle"), Type.Literal("working")]),
  offline: Type.Optional(Type.Boolean()),
});
export type SessionRecord = Static<typeof SessionRecordSchema>;

export type Presence = "live" | "stalled" | "offline";

export const HEARTBEAT_STALE_MS = 45_000;
/** A mailbox holding undelivered mail is kept this long after last contact. */
export const SWEEP_MAIL_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const ADDRESS_PATTERN = /^[a-f0-9]{12}$/;

export function deriveAddr(cwd: string, sessionId: string): string {
  return createHash("sha256").update(`${cwd}${sessionId}`).digest("hex").slice(0, 12);
}

/** Validate a talk address before it becomes a storage key. */
export function assertAddress(addr: string): void {
  if (!ADDRESS_PATTERN.test(addr)) throw new TypeError(`Invalid talk address: ${addr}`);
}

// ── Storage namespaces ───────────────────────────────────────────────────

export const RECORDS_NS = "records";

export function inboxNs(addr: string): string {
  assertAddress(addr);
  return `inbox/${addr}`;
}

export function asksNs(addr: string): string {
  assertAddress(addr);
  return `asks/${addr}`;
}

function recordKey(addr: string): string {
  assertAddress(addr);
  return `${addr}.json`;
}

// ── Session records ──────────────────────────────────────────────────────

export async function writeRecord(storage: TalkStorage, record: SessionRecord): Promise<void> {
  await storage.writeJson(RECORDS_NS, recordKey(record.addr), record);
}

export async function readRecord(
  storage: TalkStorage,
  addr: string,
): Promise<SessionRecord | null> {
  const raw = await storage.readJson(RECORDS_NS, recordKey(addr));
  return Value.Check(SessionRecordSchema, raw) ? raw : null;
}

/** Read-only listing, oldest first. Never mutates anything. */
export async function listRecords(storage: TalkStorage): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for (const key of await storage.listKeys(RECORDS_NS)) {
    const addr = key.slice(0, -".json".length);
    if (!ADDRESS_PATTERN.test(addr)) continue;
    const record = await readRecord(storage, addr);
    if (record) out.push(record);
  }
  return out.toSorted((a, b) => a.startedAt - b.startedAt);
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but isn't ours — still alive
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function presenceOf(record: SessionRecord, now: number = Date.now()): Presence {
  if (record.offline) return "offline";
  if (!pidAlive(record.pid)) return "offline";
  return now - record.lastSeenAt < HEARTBEAT_STALE_MS ? "live" : "stalled";
}

// ── Sweep ────────────────────────────────────────────────────────────────

/**
 * Reclaim dead sessions' data. Rules (mail outranks tidiness):
 * - a running session is never touched;
 * - a mailbox holding undelivered mail is kept for SWEEP_MAIL_KEEP_MS;
 * - an offline but resumable session keeps its record (its address — new
 *   mail must remain deliverable while it's down);
 * - only an empty mailbox of a session that can no longer be resumed is
 *   discarded promptly.
 *
 * `sessionExists(sessionId)` reports whether pi can still resume the session
 * (its session file is present). When omitted, every offline session is
 * treated as resumable (the conservative choice).
 */
export async function sweep(
  storage: TalkStorage,
  now: number = Date.now(),
  sessionExists?: (sessionId: string) => boolean,
): Promise<void> {
  for (const record of await listRecords(storage)) {
    if (presenceOf(record, now) !== "offline") continue;
    const hasMail =
      (await storage.hasKeys(inboxNs(record.addr))) || (await storage.hasKeys(asksNs(record.addr)));
    const expired = now - record.lastSeenAt >= SWEEP_MAIL_KEEP_MS;
    if (hasMail && !expired) continue;
    if (!expired && (sessionExists?.(record.sessionId) ?? true)) continue;
    await storage.removeNamespace(inboxNs(record.addr));
    await storage.removeNamespace(asksNs(record.addr));
    await storage.removeKey(RECORDS_NS, recordKey(record.addr));
  }
}
