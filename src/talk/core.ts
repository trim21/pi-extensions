/**
 * Talk core: coordinates the registry, mailbox, and policy over a storage
 * backend, and yields deliveries and notifications to an adapter through
 * events. Pi-free — the pi adapter (index.ts) owns the pi API surface.
 *
 * Delivery model: a letter is removed from the inbox only AFTER the adapter
 * reports it was handed to the session (`events.deliver` returns true). A
 * letter whose delivery fails stays in the inbox and is retried on the next
 * poll — so a swallowed sendMessage error no longer destroys the letter.
 */

import { isAbsolute, resolve } from "node:path";

import { expandHome } from "../lib/path.js";
import { formatDelivery, formatListing, refusalUnknown, shortAddr } from "./format.js";
import {
  appendAudit,
  awaitReceipt,
  clearAsk,
  deposit,
  type InboxItem,
  type Letter,
  type LetterKind,
  listInbox,
  newMessageId,
  type OutAsk,
  outgoingAskIds,
  previewBody,
  readOutgoingAsk,
  removeLetter,
  resolveAskByRef,
  trackIncomingAsk,
  trackOutgoingAsk,
  unreadCount,
} from "./mailbox.js";
import { inboundAccepts, OutboundPolicy } from "./policy.js";
import {
  LIST_ACTIVE_MS,
  listRecords,
  type Presence,
  presenceOf,
  readRecord,
  type SessionRecord,
  sweep,
  writeRecord,
} from "./registry.js";
import type { TalkStorage } from "./storage.js";

type AskOutcome =
  { replied: true; body: string; from: string } | { replied: false; reason: string };
type TargetResult = { ok: true; record: SessionRecord } | { ok: false; error: string };
type SendResult = { ok: true; letter: Letter; verdict: string } | { ok: false; error: string };

export interface TalkCoreEvents {
  /** Hand a received letter to the adapter (pi.sendMessage). Return true when accepted. */
  deliver(letter: Letter): boolean | Promise<boolean>;
  /** Surface a notification (e.g. a presence transition) without waking a busy agent. */
  notify(content: string): void;
}

export interface TalkCoreOptions {
  storage: TalkStorage;
  events: TalkCoreEvents;
  now?: () => number;
}

const INBOX_POLL_MS = 3000;
const HEARTBEAT_MS = 15_000;
const WATCH_POLL_MS = 5000;
const DELIVERY_BACKOFF_MS = 5000;
const INITIAL_DRAIN_DELAY_MS = 1200;
const WAIT_POLL_MS = 500;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normalize an allowed path: expand ~, resolve relative against baseCwd, strip trailing slashes. */
function normalizeAllowedPath(p: string, baseCwd: string): string {
  const expanded = expandHome(p);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(baseCwd, expanded);
  return abs.replace(/[\\/]+$/, "") || "/";
}

/**
 * Build the workspace-visibility gate for one session. `allowed` is the
 * `allowed` array from `<cwd>/.pi/talk.json` (undefined when the file or key
 * is absent). A peer session is visible when its cwd equals an allowed prefix
 * or sits below it (`prefix` or `prefix/*`); `company1` never matches
 * `company12`. An undefined list shows everything; an explicit empty list
 * shows nothing.
 */
export function buildVisibilityFilter(
  allowed: string[] | undefined,
  baseCwd: string,
): (peerCwd: string) => boolean {
  if (allowed === undefined) return () => true;
  if (allowed.length === 0) return () => false;
  const prefixes = allowed.map((p) => normalizeAllowedPath(p, baseCwd));
  return (peerCwd) =>
    prefixes.some((prefix) => peerCwd === prefix || peerCwd.startsWith(`${prefix}/`));
}

/**
 * Mutual-ask arbitration: true when the peer asked first. The `ts` fields of
 * the two ask letters are fixed values inside the letters, so both sides
 * compare the same pair and reach symmetric conclusions. On a same-ms
 * collision, `cwd + sessionId` breaks the tie deterministically.
 */
export function peerAskedFirst(
  peer: { ts: number; cwd: string; sessionId: string },
  self: { ts: number; cwd: string; sessionId: string },
): boolean {
  const peerKey = `${peer.cwd}\u0000${peer.sessionId}`;
  const selfKey = `${self.cwd}\u0000${self.sessionId}`;
  return peer.ts < self.ts || (peer.ts === self.ts && peerKey < selfKey);
}

export class TalkCore {
  private readonly storage: TalkStorage;
  private readonly events: TalkCoreEvents;
  private readonly now: () => number;

  private self: SessionRecord | undefined;
  private readonly policy = new OutboundPolicy();
  private readonly askWaiters = new Map<string, (outcome: AskOutcome) => void>();
  private readonly watched = new Map<string, Presence>();
  /** Message ids already handed to the adapter but not yet removed from the inbox. */
  private readonly deliveredIds = new Set<string>();
  /** Visibility gate over peer working directories; defaults to everything visible. */
  private isPeerVisible: (peerCwd: string) => boolean = () => true;

  private inboxPoll: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private watchPoller: ReturnType<typeof setInterval> | undefined;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private lastDeliveryFailureAt = 0;

  constructor(options: TalkCoreOptions) {
    this.storage = options.storage;
    this.events = options.events;
    this.now = options.now ?? Date.now;
  }

  get selfAddr(): string | undefined {
    return this.self?.addr;
  }

  /** Replace the peer-visibility gate (from the session's `.pi/talk.json`). */
  setPeerVisibility(filter: (peerCwd: string) => boolean): void {
    this.isPeerVisible = filter;
  }

  private requireSelf(): SessionRecord {
    const self = this.self;
    if (!self) throw new Error("Talk core is not started");
    return self;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(self: SessionRecord): Promise<void> {
    await this.storage.init();
    this.self = self;
    await writeRecord(this.storage, self);
    try {
      await sweep(this.storage, this.now());
    } catch {
      // sweep failure never breaks the session
    }
    this.startInboxPoll();
    this.heartbeat = setInterval(() => {
      void this.writeSelf({});
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
    // Reclaim dead records periodically, not just at startup.
    this.sweeper = setInterval(() => {
      void sweep(this.storage, this.now());
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref();
    // Drain mail queued while offline — deferred: delivering during
    // session_start races the session's own first turn.
    const initial = setTimeout(() => {
      void this.checkInbox();
    }, INITIAL_DRAIN_DELAY_MS);
    initial.unref();
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchPoller) clearInterval(this.watchPoller);
    if (this.inboxPoll) clearInterval(this.inboxPoll);
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.self) {
      try {
        await this.writeSelf({ status: "idle", offline: true });
      } catch {
        // best-effort on shutdown
      }
    }
  }

  setWorking(): void {
    void this.writeSelf({ status: "working" });
  }

  setIdle(): void {
    void this.writeSelf({ status: "idle" });
  }

  setSessionName(name: string): void {
    void this.writeSelf({ name });
  }

  private async writeSelf(patch: Partial<SessionRecord>): Promise<void> {
    if (!this.self) return;
    this.self = { ...this.self, ...patch, lastSeenAt: this.now() };
    try {
      await writeRecord(this.storage, this.self);
    } catch {
      // heartbeat/registration failures never break the session
    }
  }

  private startInboxPoll(): void {
    if (this.inboxPoll) return;
    this.inboxPoll = setInterval(() => {
      void this.checkInbox();
    }, INBOX_POLL_MS);
    this.inboxPoll.unref();
  }

  // ── Inbound ────────────────────────────────────────────────────────────

  /** Drain the inbox and hand each letter to the adapter. Public so tests can drive it. */
  async checkInbox(): Promise<void> {
    const self = this.self;
    if (!self) return;
    if (this.now() - this.lastDeliveryFailureAt < DELIVERY_BACKOFF_MS) return;
    // Refuse mode: never drain — letters stay queued (receipts honestly read
    // 'queued') instead of being silently consumed and dropped.
    if (!inboundAccepts()) return;
    const items = await listInbox(this.storage, self.addr);
    for (const item of items) {
      if (this.deliveredIds.has(item.letter.id)) {
        // Already delivered in a previous poll but the remove failed; only remove.
        if (await removeLetter(this.storage, self.addr, item.fileName)) {
          this.deliveredIds.delete(item.letter.id);
        }
        continue;
      }
      const accepted = await this.deliver(item.letter);
      if (accepted) {
        this.deliveredIds.add(item.letter.id);
        if (await removeLetter(this.storage, self.addr, item.fileName)) {
          this.deliveredIds.delete(item.letter.id);
        }
      } else {
        this.lastDeliveryFailureAt = this.now();
      }
    }
  }

  /**
   * Shared per-letter inbound handling: route replies/cancels to their
   * waiters, and run ask interlock arbitration + incoming-ask tracking.
   * Returns false when the letter was fully handled here (routed to a waiter)
   * and must not be handed to the model.
   */
  private async processIncoming(letter: Letter): Promise<boolean> {
    const self = this.requireSelf();
    if ((letter.kind === "reply" || letter.kind === "cancel") && letter.replyTo) {
      const waiter = this.askWaiters.get(letter.replyTo);
      await clearAsk(this.storage, self.addr, letter.replyTo);
      if (waiter) {
        this.askWaiters.delete(letter.replyTo);
        waiter(
          letter.kind === "reply"
            ? { replied: true, body: letter.body, from: letter.from.name }
            : { replied: false, reason: `cancelled by ${letter.from.name}` },
        );
        return false;
      }
    }
    if (letter.kind === "ask") {
      // Both sides asking each other: timestamp arbitration before delivering,
      // so the later asker yields and answers the earlier ask instead of
      // both timing out.
      await this.resolveInterlock(letter);
      await trackIncomingAsk(this.storage, self.addr, letter);
    }
    return true;
  }

  private async deliver(letter: Letter): Promise<boolean> {
    const self = this.requireSelf();
    const auditDelivery = (event: "deliver" | "deliver-failed") =>
      appendAudit(this.storage, {
        ts: this.now(),
        event,
        kind: letter.kind,
        from: letter.from.addr,
        to: self.addr,
        messageId: letter.id,
        preview: previewBody(letter.body),
      });
    if (!(await this.processIncoming(letter))) {
      await auditDelivery("deliver");
      return true;
    }
    try {
      const accepted = await this.events.deliver(letter);
      await auditDelivery(accepted ? "deliver" : "deliver-failed");
      return accepted;
    } catch {
      await auditDelivery("deliver-failed");
      return false;
    }
  }

  /** Read and consume fresh inbox letters, returning those to present to the model. */
  private async consumeFresh(items: InboxItem[]): Promise<Letter[]> {
    const self = this.requireSelf();
    const fresh: Letter[] = [];
    for (const item of items) {
      if (this.deliveredIds.has(item.letter.id)) {
        // Already handed out in a previous pass but the remove failed; only remove.
        if (await removeLetter(this.storage, self.addr, item.fileName)) {
          this.deliveredIds.delete(item.letter.id);
        }
        continue;
      }
      if (await this.processIncoming(item.letter)) fresh.push(item.letter);
      if (await removeLetter(this.storage, self.addr, item.fileName)) {
        // consumed
      } else {
        this.deliveredIds.add(item.letter.id);
      }
    }
    return fresh;
  }

  // ── Outbound ───────────────────────────────────────────────────────────

  /**
   * Resolve a target by its exact session id (uuid). A peer must be visible
   * from this session (`setPeerVisibility`); invisible peers are unreachable
   * even with a known id.
   */
  private async resolveTarget(to: string): Promise<TargetResult> {
    const self = this.requireSelf();
    const records = await listRecords(this.storage);
    const others = records.filter((r) => r.addr !== self.addr && this.isPeerVisible(r.cwd));
    const target = others.find((r) => r.sessionId === to);
    if (!target) return { ok: false, error: refusalUnknown(to) };
    return { ok: true, record: target };
  }

  private async sendLetter(
    target: SessionRecord,
    kind: LetterKind,
    body: string,
    replyTo?: string,
  ): Promise<SendResult> {
    const self = this.requireSelf();
    const presence = presenceOf(target);
    const backlog =
      presence === "live" && target.status === "idle"
        ? 0
        : await unreadCount(this.storage, target.addr);
    const verdict = this.policy.check(body, backlog, target.addr);
    if (!verdict.ok) return { ok: false, error: verdict.reason };
    const letter: Letter = {
      id: newMessageId(),
      from: { addr: self.addr, name: self.name, cwd: self.cwd, sessionId: self.sessionId },
      kind,
      body,
      ts: this.now(),
    };
    if (replyTo !== undefined) letter.replyTo = replyTo;
    await deposit(this.storage, target.addr, letter);
    this.policy.recordSend(body, target.addr);
    if (presence === "live") {
      const receipt = await awaitReceipt(this.storage, target.addr, letter, 3000);
      return {
        ok: true,
        letter,
        verdict:
          receipt === "delivered"
            ? "delivered"
            : "queued (waits on disk until the session resumes)",
      };
    }
    return {
      ok: true,
      letter,
      verdict: `queued (target ${presence === "stalled" ? "is not responding" : "is offline"} — waits on disk)`,
    };
  }

  private waitForReply(
    askId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<AskOutcome> {
    return new Promise((resolve) => {
      const settle = (outcome: AskOutcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.askWaiters.delete(askId);
        resolve(outcome);
      };
      const timer = setTimeout(
        () =>
          settle({ replied: false, reason: `no reply within ${Math.round(timeoutMs / 1000)}s` }),
        timeoutMs,
      );
      const onAbort = () => settle({ replied: false, reason: "aborted" });
      this.askWaiters.set(askId, settle);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Find our own outstanding ask addressed to `toAddr`, if any. */
  private async findOutAskTo(toAddr: string): Promise<OutAsk | undefined> {
    const self = this.requireSelf();
    for (const askId of await outgoingAskIds(this.storage, self.addr)) {
      const out = await readOutgoingAsk(this.storage, self.addr, askId);
      if (out && out.toAddr === toAddr) return out;
    }
    return undefined;
  }

  /**
   * Mutual-ask deadlock arbitration. Runs when we receive an ask while we are
   * ourselves blocked asking the same peer. Each side compares the two ask
   * letters' `ts` (a fixed field inside the letter, so both sides read the
   * same pair of values and reach symmetric conclusions):
   *
   * - the earlier ask keeps the lead and keeps waiting for a reply;
   * - the later ask yields: its waiter is settled with a "peer asked first"
   *   reason, and the peer's ask is delivered so this side answers it first.
   *
   * On a same-millisecond ts collision, session dir + session id (carried in
   * `letter.from`) breaks the tie deterministically — both sides compute the
   * same comparison and reach symmetric conclusions.
   */
  private async resolveInterlock(letter: Letter): Promise<void> {
    const self = this.requireSelf();
    const myAsk = await this.findOutAskTo(letter.from.addr);
    if (!myAsk) return;
    const waiter = this.askWaiters.get(myAsk.askId);
    if (!waiter) return;
    const peerFirst = peerAskedFirst(
      { ts: letter.ts, cwd: letter.from.cwd, sessionId: letter.from.sessionId },
      { ts: myAsk.ts, cwd: self.cwd, sessionId: self.sessionId },
    );
    if (!peerFirst) return; // we asked first; keep waiting — the peer will yield
    this.askWaiters.delete(myAsk.askId);
    waiter({
      replied: false,
      reason: `peer asked first (their ask id ${letter.id.slice(0, 8)}) — answer it with talk-reply before re-asking`,
    });
    await clearAsk(this.storage, self.addr, myAsk.askId);
  }

  // ── Tool actions ───────────────────────────────────────────────────────

  /** Block until a message arrives (or timeout/abort). */
  async wait(timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const self = this.requireSelf();
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const inbox = await listInbox(this.storage, self.addr);
      const fresh = await this.consumeFresh(inbox);
      if (fresh.length > 0) return fresh.map((l) => formatDelivery(l)).join("\n\n");
      if (signal?.aborted) return "aborted";
      if (this.now() >= deadline) return `No message within ${Math.round(timeoutMs / 1000)}s.`;
      await sleep(WAIT_POLL_MS);
    }
  }

  /**
   * JSON listing of visible peer sessions. Defaults to sessions whose
   * heartbeat is fresh (within LIST_ACTIVE_MS); pass includeOffline to show
   * every visible peer regardless of last contact.
   */
  async list(includeOffline = false): Promise<string> {
    const self = this.requireSelf();
    const now = this.now();
    const all = await listRecords(this.storage);
    const records = all.filter(
      (r) => this.isPeerVisible(r.cwd) && (includeOffline || now - r.lastSeenAt < LIST_ACTIVE_MS),
    );
    return formatListing(records, self.addr, (r) => presenceOf(r, now));
  }

  /** Same as list(), filtered to one working directory. */
  async listCwd(cwd: string, includeOffline = false): Promise<string> {
    const self = this.requireSelf();
    const now = this.now();
    const records = await listRecords(this.storage);
    const filtered = records.filter(
      (r) =>
        r.cwd === cwd &&
        this.isPeerVisible(r.cwd) &&
        (includeOffline || now - r.lastSeenAt < LIST_ACTIVE_MS),
    );
    return formatListing(filtered, self.addr, (r) => presenceOf(r, now));
  }

  async send(to: string, body: string): Promise<string> {
    if (!to) return 'send requires "to".';
    if (!body) return 'send requires "message".';
    const self = this.requireSelf();
    // Broadcast: N atomic deposits through the existing deposit path so
    // rate/dedupe caps still bind (per-peer dedupe; rate caps total fan-out).
    if (to === "*" || to === "cwd") {
      const records = await listRecords(this.storage);
      const peers = records.filter((r) => {
        if (r.addr === self.addr) return false;
        if (!this.isPeerVisible(r.cwd)) return false;
        return to === "*" ? true : r.cwd === self.cwd;
      });
      if (peers.length === 0) return "No other sessions to broadcast to.";
      const ok: string[] = [];
      const failed: string[] = [];
      for (const peer of peers) {
        const sent = await this.sendLetter(peer, "message", body);
        if (sent.ok) ok.push(`"${peer.name}"`);
        else failed.push(`"${peer.name}": ${sent.error}`);
      }
      const head = `Broadcast to ${ok.length}/${peers.length} session${peers.length === 1 ? "" : "s"}.`;
      const detail = failed.length > 0 ? ` Refused: ${failed.join("; ")}.` : "";
      return head + detail;
    }
    const resolved = await this.resolveTarget(to);
    if (!resolved.ok) return resolved.error;
    const sent = await this.sendLetter(resolved.record, "message", body);
    if (!sent.ok) return sent.error;
    return `Sent to "${resolved.record.name}" (${shortAddr(resolved.record.addr)}) [id ${sent.letter.id.slice(0, 8)}]: ${sent.verdict}.`;
  }

  async ask(to: string, body: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (!to) return 'ask requires "to".';
    if (!body) return 'ask requires "message".';
    if (to === "*" || to === "cwd") {
      return 'ask is 1:1 and cannot broadcast; use send with to: "*" or "cwd".';
    }
    const self = this.requireSelf();
    const resolved = await this.resolveTarget(to);
    if (!resolved.ok) return resolved.error;
    const record = resolved.record;
    // Fast-path deadlock avoidance: if the target already sent us something,
    // answer them first instead of blocking on a fresh ask. This closes the
    // common case; resolveInterlock() covers the remaining race.
    const inbox = await listInbox(this.storage, self.addr);
    const fromTarget = inbox.filter((item) => item.letter.from.addr === record.addr);
    if (fromTarget.length > 0) {
      return `You have ${fromTarget.length} unread message(s) from "${record.name}" — reply before asking.`;
    }
    const sent = await this.sendLetter(record, "ask", body);
    if (!sent.ok) return sent.error;
    await trackOutgoingAsk(this.storage, self.addr, {
      askId: sent.letter.id,
      toAddr: record.addr,
      body,
      ts: sent.letter.ts,
    });
    const outcome = await this.waitForReply(sent.letter.id, Math.max(1000, timeoutMs), signal);
    await clearAsk(this.storage, self.addr, sent.letter.id);
    if (!outcome.replied)
      return `Ask ${sent.letter.id.slice(0, 8)} to "${record.name}": ${outcome.reason}.`;
    return `"${record.name}" replied:\n\n${outcome.body}`;
  }

  async reply(replyTo: string, body: string): Promise<string> {
    if (!body) return "reply requires 'message'.";
    if (!replyTo) {
      return "reply requires 'replyTo' (the ask/message id, shown in the delivered message).";
    }
    const self = this.requireSelf();
    const ask = await resolveAskByRef(this.storage, self.addr, replyTo);
    if (!ask) return `No pending ask matches '${replyTo}'.`;
    const records = await listRecords(this.storage);
    const asker = records.find((r) => r.addr === ask.from.addr);
    const target = asker ?? this.recordFromLetter(ask);
    const sent = await this.sendLetter(target, "reply", body, ask.id);
    if (!sent.ok) return sent.error;
    await clearAsk(this.storage, self.addr, ask.id);
    return `Replied to "${target.name}" (ask ${ask.id.slice(0, 8)}): ${sent.verdict}.`;
  }

  /** Build a minimal record from a letter's sender when the peer record is gone. */
  private recordFromLetter(letter: Letter): SessionRecord {
    return {
      addr: letter.from.addr,
      sessionId: letter.from.sessionId,
      name: letter.from.name,
      cwd: letter.from.cwd,
      pid: 0,
      startedAt: letter.ts,
      lastSeenAt: letter.ts,
      status: "idle",
    };
  }

  // ── Presence watch ─────────────────────────────────────────────────────

  async watch(to: string): Promise<string> {
    if (!to) return "watch requires 'to' (a peer name or address prefix).";
    const resolved = await this.resolveTarget(to);
    if (!resolved.ok) return resolved.error;
    this.watched.set(resolved.record.addr, presenceOf(resolved.record));
    this.startWatchPoller();
    return `Watching "${resolved.record.name}" (${shortAddr(resolved.record.addr)}) for presence transitions. Notifications arrive as talk messages.`;
  }

  private startWatchPoller(): void {
    if (this.watchPoller) return;
    this.watchPoller = setInterval(() => {
      void this.pollWatched();
    }, WATCH_POLL_MS);
    this.watchPoller.unref();
  }

  private async pollWatched(): Promise<void> {
    if (!this.self || this.watched.size === 0) return;
    for (const [addr, prev] of this.watched) {
      const rec = await readRecord(this.storage, addr);
      const now: Presence = rec ? presenceOf(rec) : "offline";
      if (now === prev) continue;
      this.watched.set(addr, now);
      const label = rec ? `"${rec.name}"` : shortAddr(addr);
      const state =
        now === "live" ? (rec?.status ?? "idle") : now === "stalled" ? "not responding" : "offline";
      this.events.notify(`talk watch: ${label} is now ${state}.`);
    }
  }
}
