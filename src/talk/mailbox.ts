/**
 * Letter transport for the talk mailbox. Core layer — depends only on
 * TalkStorage, never on pi.
 *
 * Guarantees:
 * - A reader never sees half a letter: writes are atomic (single SQL upsert).
 * - Consumption is decoupled from delivery: `listInbox` only reads; the
 *   caller removes a letter with `removeLetter` AFTER it has been handed to
 *   the session. A letter that could not be delivered stays in the inbox and
 *   is retried on the next poll.
 * - Every value read from storage is validated with a TypeBox schema.
 * - Every deposit and delivery appends one append-only audit line. The log
 *   never holds a full body, only a short preview.
 */

import { randomUUID } from "node:crypto";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { asksNs, assertAddress, inboxNs } from "./registry.js";
import type { TalkStorage } from "./storage.js";

export const LetterSchema = Type.Object({
  id: Type.String(),
  from: Type.Object({
    addr: Type.String(),
    name: Type.String(),
    cwd: Type.String(),
    sessionId: Type.String(),
  }),
  kind: Type.Union([
    Type.Literal("message"),
    Type.Literal("ask"),
    Type.Literal("reply"),
    Type.Literal("cancel"),
  ]),
  body: Type.String(),
  replyTo: Type.Optional(Type.String()),
  ts: Type.Number(),
});
export type Letter = Static<typeof LetterSchema>;
export type LetterKind = Letter["kind"];

export const OutAskSchema = Type.Object({
  askId: Type.String(),
  toAddr: Type.String(),
  body: Type.String(),
  ts: Type.Number(),
});
export type OutAsk = Static<typeof OutAskSchema>;

export const AuditRecordSchema = Type.Object({
  ts: Type.Number(),
  event: Type.Union([
    Type.Literal("deposit"),
    Type.Literal("deliver"),
    Type.Literal("deliver-failed"),
  ]),
  kind: Type.Union([
    Type.Literal("message"),
    Type.Literal("ask"),
    Type.Literal("reply"),
    Type.Literal("cancel"),
  ]),
  from: Type.String(),
  to: Type.String(),
  messageId: Type.String(),
  preview: Type.String(),
});
export type AuditRecord = Static<typeof AuditRecordSchema>;

export const MAX_BODY_CHARS = 32 * 1024;

const MESSAGE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function newMessageId(): string {
  return randomUUID();
}

function assertMessageId(id: string): void {
  if (!MESSAGE_ID_PATTERN.test(id)) throw new TypeError(`Invalid talk message id: ${id}`);
}

/** The storage key for a letter: `<ts>-<id>.json`, sorted oldest-first. */
export function letterFileName(letter: Letter): string {
  assertMessageId(letter.id);
  if (!Number.isSafeInteger(letter.ts) || letter.ts < 0) {
    throw new TypeError(`Invalid talk letter timestamp: ${letter.ts}`);
  }
  return `${letter.ts}-${letter.id}.json`;
}

/** Structural validation plus filename safety (id/timestamp shape). */
export function isValidLetter(value: unknown): value is Letter {
  if (!Value.Check(LetterSchema, value)) return false;
  try {
    letterFileName(value);
    return true;
  } catch {
    return false;
  }
}

// ── Inbox (delivery) ─────────────────────────────────────────────────────

/**
 * Atomically deposit a letter into a peer's inbox, then append a deposit
 * audit line.
 */
export async function deposit(storage: TalkStorage, toAddr: string, letter: Letter): Promise<void> {
  assertAddress(toAddr);
  await storage.writeJson(inboxNs(toAddr), letterFileName(letter), letter);
  await appendAudit(storage, {
    ts: Date.now(),
    event: "deposit",
    kind: letter.kind,
    from: letter.from.addr,
    to: toAddr,
    messageId: letter.id,
    preview: previewBody(letter.body),
  });
}

export interface InboxItem {
  fileName: string;
  letter: Letter;
}

/** Read every letter in the inbox, oldest first, WITHOUT removing anything. */
export async function listInbox(storage: TalkStorage, addr: string): Promise<InboxItem[]> {
  assertAddress(addr);
  const out: InboxItem[] = [];
  for (const fileName of await storage.listKeys(inboxNs(addr))) {
    const raw = await storage.readJson(inboxNs(addr), fileName);
    if (isValidLetter(raw)) out.push({ fileName, letter: raw });
    // corrupt letters are skipped; the caller may remove them separately
  }
  return out; // keys are already sorted by listKeys
}

/** Remove a delivered letter from the inbox. Idempotent. */
export async function removeLetter(
  storage: TalkStorage,
  addr: string,
  fileName: string,
): Promise<boolean> {
  assertAddress(addr);
  return storage.removeKey(inboxNs(addr), fileName);
}

export async function unreadCount(storage: TalkStorage, addr: string): Promise<number> {
  assertAddress(addr);
  const keys = await storage.listKeys(inboxNs(addr));
  return keys.length;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Consumption receipt: after depositing to a LIVE target, wait briefly for
 * the exact letter to vanish from the target's inbox. Under the
 * deliver-then-remove semantics, disappearance means the receiver actually
 * handed the letter to its session, not merely drained it.
 */
export async function awaitReceipt(
  storage: TalkStorage,
  toAddr: string,
  letter: Letter,
  timeoutMs = 1500,
): Promise<"delivered" | "queued"> {
  assertAddress(toAddr);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inbox = await listInbox(storage, toAddr);
    const stillThere = inbox.some((i) => i.letter.id === letter.id);
    if (!stillThere) return "delivered";
    await sleep(100);
  }
  const inbox = await listInbox(storage, toAddr);
  return inbox.some((i) => i.letter.id === letter.id) ? "queued" : "delivered";
}

// ── Ask tracking ─────────────────────────────────────────────────────────
// Received asks live at asks/<addr>/<id>.json until we reply; our outgoing
// asks live at asks/<addr>/out-<id>.json until a reply/cancel arrives or we
// time out.

function askKey(askId: string): string {
  assertMessageId(askId);
  return `${askId}.json`;
}

function outAskKey(askId: string): string {
  assertMessageId(askId);
  return `out-${askId}.json`;
}

export async function trackIncomingAsk(
  storage: TalkStorage,
  addr: string,
  letter: Letter,
): Promise<void> {
  await storage.writeJson(asksNs(addr), askKey(letter.id), letter);
}

export async function trackOutgoingAsk(
  storage: TalkStorage,
  addr: string,
  out: OutAsk,
): Promise<void> {
  await storage.writeJson(asksNs(addr), outAskKey(out.askId), out);
}

export async function readIncomingAsk(
  storage: TalkStorage,
  addr: string,
  askId: string,
): Promise<Letter | null> {
  const raw = await storage.readJson(asksNs(addr), askKey(askId));
  return Value.Check(LetterSchema, raw) ? raw : null;
}

export async function readOutgoingAsk(
  storage: TalkStorage,
  addr: string,
  askId: string,
): Promise<OutAsk | null> {
  const raw = await storage.readJson(asksNs(addr), outAskKey(askId));
  return Value.Check(OutAskSchema, raw) ? raw : null;
}

/** Remove both sides of an ask id (incoming and/or outgoing). Idempotent. */
export async function clearAsk(storage: TalkStorage, addr: string, askId: string): Promise<void> {
  await storage.removeKey(asksNs(addr), askKey(askId));
  await storage.removeKey(asksNs(addr), outAskKey(askId));
}

/** Asks we have received and not yet answered, oldest first. */
export async function pendingAsks(storage: TalkStorage, addr: string): Promise<Letter[]> {
  const out: Letter[] = [];
  for (const key of await storage.listKeys(asksNs(addr))) {
    if (key.startsWith("out-")) continue;
    const raw = await storage.readJson(asksNs(addr), key);
    if (Value.Check(LetterSchema, raw)) out.push(raw);
  }
  return out;
}

/** Outgoing ask ids, used by the adapter for prefix resolution. */
export async function outgoingAskIds(storage: TalkStorage, addr: string): Promise<string[]> {
  const out: string[] = [];
  for (const key of await storage.listKeys(asksNs(addr))) {
    if (!key.startsWith("out-") || !key.endsWith(".json")) continue;
    out.push(key.slice("out-".length, -".json".length));
  }
  return out;
}

/** Resolve a pending ask by explicit replyTo id or unique prefix. No inference. */
export async function resolveAskByRef(
  storage: TalkStorage,
  addr: string,
  replyTo: string,
): Promise<Letter | null> {
  if (!replyTo) return null; // empty prefix matches every id — an explicit ref is required
  const asks = await pendingAsks(storage, addr);
  return asks.find((a) => a.id === replyTo || a.id.startsWith(replyTo)) ?? null;
}

// ── Audit log ────────────────────────────────────────────────────────────

const AUDIT_LOG = "audit";
const AUDIT_PREVIEW_CHARS = 80;

/** Whitespace-collapsed body preview — never the full payload. */
export function previewBody(body: string): string {
  // Strip ANSI/CSI escapes — the preview is peer-controlled text that can
  // reach a raw terminal via the non-UI audit print path.
  // eslint-disable-next-line no-control-regex -- intentionally strips ANSI escapes
  const stripped = body.replaceAll(/\x1B\[[0-9;?]*[a-zA-Z]|\x1B./g, "");
  return stripped.replaceAll(/\s+/g, " ").trim().slice(0, AUDIT_PREVIEW_CHARS);
}

/** Append one audit record. Best-effort: never throws (audit must not break delivery). */
export async function appendAudit(storage: TalkStorage, record: AuditRecord): Promise<void> {
  try {
    await storage.appendLog(AUDIT_LOG, JSON.stringify(record));
  } catch {
    // audit failure never breaks the mail path
  }
}

/** Read the last `limit` audit entries (oldest-first within that tail). */
export async function readAudit(storage: TalkStorage, limit = 50): Promise<AuditRecord[]> {
  const out: AuditRecord[] = [];
  for (const line of await storage.readLog(AUDIT_LOG)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (Value.Check(AuditRecordSchema, parsed)) out.push(parsed);
    } catch {
      // skip corrupt line — append-only, never fatal
    }
  }
  return out.slice(-limit);
}
