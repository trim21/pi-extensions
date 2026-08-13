/**
 * Agent registry for the talk mailbox: who is around, where, and whether
 * they are reachable. Core layer — depends only on TalkStorage, never on pi.
 *
 * Design:
 * - An address belongs to a conversation, not a process: hash of cwd + pi
 *   agent id, so a resumed agent (`pi -c`) answers to the same address and
 *   two agents on one directory never share an inbox.
 * - A record outlives the process that wrote it — that's what makes an agent
 *   addressable while it's down (mail waits on disk).
 * - Presence is the offline flag plus the pid and its start time: a record
 *   whose process is alive (pid + matching start time, ruling out pid reuse)
 *   and not flagged offline is live; everything else is offline. There is no
 *   heartbeat, so a wedged process is indistinguishable from a healthy idle
 *   one.
 * - Listing has NO side effects.
 *
 * All values read from storage are validated with TypeBox before use.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import type { TalkStorage } from "./storage.js";

const STATUS_SCHEMA = Type.Union([
  Type.Literal("idle"),
  Type.Literal("working"),
  Type.Literal("waiting-talk-message"),
]);

export const AgentRecordSchema = Type.Object({
  addr: Type.String(),
  agentId: Type.String(),
  name: Type.String(),
  cwd: Type.String(),
  pid: Type.Number(),
  pidStart: Type.Optional(Type.Number()),
  startedAt: Type.Number(),
  lastSeenAt: Type.Number(),
  status: STATUS_SCHEMA,
  offline: Type.Optional(Type.Boolean()),
});
export type AgentRecord = Static<typeof AgentRecordSchema>;

/**
 * Records written before the session→agent rename stored the pi session id
 * as `sessionId`. TypeBox ignores extra properties, so this schema also
 * matches current records; the read path checks the current schema first.
 */
const LegacyAgentRecordSchema = Type.Object({
  addr: Type.String(),
  sessionId: Type.String(),
  name: Type.String(),
  cwd: Type.String(),
  pid: Type.Number(),
  pidStart: Type.Optional(Type.Number()),
  startedAt: Type.Number(),
  lastSeenAt: Type.Number(),
  status: STATUS_SCHEMA,
  offline: Type.Optional(Type.Boolean()),
});

export type Presence = "live" | "offline";

/** Sweep leaves a record alone until its last activity was this long ago. */
export const SWEEP_OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000;
/** A mailbox holding undelivered mail is kept this long after last contact. */
export const SWEEP_MAIL_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const ADDRESS_PATTERN = /^[a-f0-9]{12}$/;

export function deriveAddr(cwd: string, agentId: string): string {
  return createHash("sha256").update(`${cwd}${agentId}`).digest("hex").slice(0, 12);
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

// ── Agent records ────────────────────────────────────────────────────────

export async function writeRecord(storage: TalkStorage, record: AgentRecord): Promise<void> {
  await storage.writeJson(RECORDS_NS, recordKey(record.addr), record);
}

export async function readRecord(storage: TalkStorage, addr: string): Promise<AgentRecord | null> {
  const raw = await storage.readJson(RECORDS_NS, recordKey(addr));
  if (Value.Check(AgentRecordSchema, raw)) return raw;
  // Migrate legacy records in place of the `sessionId` → `agentId` rename.
  if (Value.Check(LegacyAgentRecordSchema, raw)) {
    const { sessionId, ...rest } = raw as { sessionId: string } & Record<string, unknown>;
    return { ...rest, agentId: sessionId } as AgentRecord;
  }
  return null;
}

/** Read-only listing, oldest first. Never mutates anything. */
export async function listRecords(storage: TalkStorage): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for (const key of await storage.listKeys(RECORDS_NS)) {
    const addr = key.slice(0, -".json".length);
    if (!ADDRESS_PATTERN.test(addr)) continue;
    const record = await readRecord(storage, addr);
    if (record) out.push(record);
  }
  return out.toSorted((a, b) => a.startedAt - b.startedAt);
}

/**
 * Process start time (field 22 of /proc/<pid>/stat), used to rule out pid
 * reuse: pids wrap around, so an alive pid is only the same agent when its
 * start time matches the recorded one. Returns undefined on non-Linux or when
 * the stat file is unreadable.
 */
export function readStartTime(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm sits in parens and may contain spaces: split after the last ')'.
    // starttime is field 22 (1-indexed); pid and (comm) consumed two tokens,
    // so it sits at index 19 of the remainder.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttime = Number(fields[19]);
    return Number.isFinite(starttime) ? starttime : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the recorded process is really alive. `pidStart` guards against
 * pid wrap-around: when present, an alive pid only counts as live if its
 * current start time matches. Without it (legacy records) — or when /proc is
 * unreadable — we fall back to the bare pid check.
 */
function pidAlive(pid: number, pidStart?: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the process exists but isn't ours — still alive
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
  if (pidStart === undefined) return true;
  const start = readStartTime(pid);
  return start === undefined ? true : start === pidStart;
}

export function presenceOf(record: AgentRecord): Presence {
  if (record.offline) return "offline";
  if (!pidAlive(record.pid, record.pidStart)) return "offline";
  return "live";
}

// ── Sweep ────────────────────────────────────────────────────────────────

/**
 * Reclaim dead agents' data. Rules (mail outranks tidiness):
 * - a record whose process is still alive is never touched;
 * - a record whose last activity was less than SWEEP_OFFLINE_GRACE_MS ago is
 *   never touched — it may be merely down or suspended, and a resume will
 *   re-register it under the same id anyway;
 * - a mailbox holding undelivered mail is kept for SWEEP_MAIL_KEEP_MS;
 * - once the grace period has passed, an empty mailbox is discarded promptly
 *   regardless of whether pi could still resume the agent (resume re-creates
 *   the record; with no mail nothing is lost).
 */
export async function sweep(storage: TalkStorage, now: number = Date.now()): Promise<void> {
  for (const record of await listRecords(storage)) {
    // Without a heartbeat, lastSeenAt only tracks the last event, so an idle
    // live agent would look long-quiet — never reap a live process.
    if (pidAlive(record.pid, record.pidStart)) continue;
    const quietFor = now - record.lastSeenAt;
    if (quietFor < SWEEP_OFFLINE_GRACE_MS) continue;
    const hasMail =
      (await storage.hasKeys(inboxNs(record.addr))) || (await storage.hasKeys(asksNs(record.addr)));
    if (hasMail && quietFor < SWEEP_MAIL_KEEP_MS) continue;
    await storage.removeNamespace(inboxNs(record.addr));
    await storage.removeNamespace(asksNs(record.addr));
    await storage.removeKey(RECORDS_NS, recordKey(record.addr));
  }
}
