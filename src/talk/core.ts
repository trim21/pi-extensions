/**
 * Talk core: coordinates the registry, mailbox, groups, and policy over a
 * storage backend, and yields deliveries and notifications to an adapter
 * through events. Pi-free — the pi adapter (index.ts) owns the pi API surface.
 *
 * Visibility model: groups are the only visibility boundary. An agent in a
 * group sees only its co-members; an agent in no group sees only itself.
 * Membership is read live from storage on every operation, so joining or
 * leaving a group takes effect immediately for every agent.
 *
 * Delivery model: a letter is removed from the inbox only AFTER the adapter
 * reports it was handed to the agent (`events.deliver` returns true). A
 * letter whose delivery fails stays in the inbox and is retried on the next
 * poll — so a swallowed sendMessage error no longer destroys the letter.
 */

import { age, formatListing, refusalUnknown, shortAddr } from "./format.js";
import {
  deleteGroup,
  groupForAgent,
  isValidGroupName,
  listGroups,
  newGroupId,
  readGroup,
  writeGroup,
} from "./group.js";
import {
  appendAudit,
  awaitReceipt,
  clearAsk,
  deposit,
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
  type AgentRecord,
  listRecords,
  type Presence,
  presenceOf,
  readRecord,
  readStartTime,
  sweep,
  writeRecord,
} from "./registry.js";
import type { TalkStorage } from "./storage.js";

type AskOutcome =
  { replied: true; body: string; from: string } | { replied: false; reason: string };
type TargetResult = { ok: true; record: AgentRecord } | { ok: false; error: string };
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
const WATCH_POLL_MS = 5000;
const DELIVERY_BACKOFF_MS = 5000;
const INITIAL_DRAIN_DELAY_MS = 1200;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Mutual-ask arbitration: true when the peer asked first. The `ts` fields of
 * the two ask letters are fixed values inside the letters, so both sides
 * compare the same pair and reach symmetric conclusions. On a same-ms
 * collision, `cwd + agentId` breaks the tie deterministically.
 */
export function peerAskedFirst(
  peer: { ts: number; cwd: string; agentId: string },
  self: { ts: number; cwd: string; agentId: string },
): boolean {
  const peerKey = `${peer.cwd}\u0000${peer.agentId}`;
  const selfKey = `${self.cwd}\u0000${self.agentId}`;
  return peer.ts < self.ts || (peer.ts === self.ts && peerKey < selfKey);
}

export class TalkCore {
  private readonly storage: TalkStorage;
  private readonly events: TalkCoreEvents;
  private readonly now: () => number;

  private self: AgentRecord | undefined;
  private readonly policy = new OutboundPolicy();
  private readonly askWaiters = new Map<string, (outcome: AskOutcome) => void>();
  private readonly watched = new Map<string, Presence>();
  /** Message ids already handed to the adapter but not yet removed from the inbox. */
  private readonly deliveredIds = new Set<string>();
  /** Manually marked dead: offline flag set, lastSeenAt pinned to 0. */
  private dead = false;

  private inboxPoll: ReturnType<typeof setInterval> | undefined;
  private watchPoller: ReturnType<typeof setInterval> | undefined;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private initialDrain: ReturnType<typeof setTimeout> | undefined;
  private lastDeliveryFailureAt = 0;

  constructor(options: TalkCoreOptions) {
    this.storage = options.storage;
    this.events = options.events;
    this.now = options.now ?? Date.now;
  }

  get selfAddr(): string | undefined {
    return this.self?.addr;
  }

  private requireSelf(): AgentRecord {
    const self = this.self;
    if (!self) throw new Error("Talk core is not started");
    return self;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(self: AgentRecord): Promise<void> {
    await this.storage.init();
    // Record the process start time so presence can rule out pid reuse later.
    const pidStart = readStartTime(self.pid);
    this.self = pidStart === undefined ? self : { ...self, pidStart };
    await writeRecord(this.storage, this.self);
    try {
      await sweep(this.storage, this.now());
    } catch {
      // sweep failure never breaks the agent
    }
    this.startInboxPoll();
    // Reclaim dead records periodically, not just at startup.
    this.sweeper = setInterval(() => {
      void sweep(this.storage, this.now());
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref();
    // Drain mail queued while offline — deferred: delivering during
    // session_start races the agent's own first turn.
    const initial = setTimeout(() => {
      void this.checkInbox();
    }, INITIAL_DRAIN_DELAY_MS);
    initial.unref();
    this.initialDrain = initial;
  }

  async stop(): Promise<void> {
    if (this.initialDrain) clearTimeout(this.initialDrain);
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

  /** Blocked on talk-ask — visible as "waiting-talk-message". */
  setWaiting(): void {
    void this.writeSelf({ status: "waiting-talk-message" });
  }

  setIdle(): void {
    void this.writeSelf({ status: "idle" });
  }

  setAgentName(name: string): void {
    void this.writeSelf({ name });
  }

  private async writeSelf(patch: Partial<AgentRecord>): Promise<void> {
    if (!this.self) return;
    // A dead agent pins lastSeenAt to 0 so no later event re-freshens it.
    this.self = { ...this.self, ...patch, lastSeenAt: this.dead ? 0 : this.now() };
    try {
      await writeRecord(this.storage, this.self);
    } catch {
      // registration failures never break the agent
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

  // ── Outbound ───────────────────────────────────────────────────────────

  /**
   * Agent ids of the caller's group members, or null when the caller is in
   * no group. Visibility is read live from storage on every operation, so a
   * group change takes effect immediately for every agent.
   */
  private async myGroupMemberIds(): Promise<Set<string> | null> {
    const self = this.requireSelf();
    const group = await groupForAgent(this.storage, self.agentId);
    return group ? new Set(group.members) : null;
  }

  /**
   * Resolve a target by its exact agent id (uuid). Only co-members of the
   * caller's group are reachable; an agent in no group sees no peers at all.
   */
  private async resolveTarget(to: string): Promise<TargetResult> {
    const self = this.requireSelf();
    const records = await listRecords(this.storage);
    const memberIds = await this.myGroupMemberIds();
    const others = records.filter((r) => r.addr !== self.addr && memberIds?.has(r.agentId));
    const target = others.find((r) => r.agentId === to);
    if (!target) return { ok: false, error: refusalUnknown(to) };
    return { ok: true, record: target };
  }

  private async sendLetter(
    target: AgentRecord,
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
      from: { addr: self.addr, name: self.name, cwd: self.cwd, agentId: self.agentId },
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
          receipt === "delivered" ? "delivered" : "queued (waits on disk until the agent resumes)",
      };
    }
    return {
      ok: true,
      letter,
      verdict: `queued (target is offline — waits on disk)`,
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
   * On a same-millisecond ts collision, agent dir + agent id (carried in
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
      { ts: letter.ts, cwd: letter.from.cwd, agentId: letter.from.agentId },
      { ts: myAsk.ts, cwd: self.cwd, agentId: self.agentId },
    );
    if (!peerFirst) return; // we asked first; keep waiting — the peer will yield
    this.askWaiters.delete(myAsk.askId);
    waiter({
      replied: false,
      reason: `peer asked first (their ask id ${letter.id.slice(-8)}) — answer it with talk-reply before re-asking`,
    });
    await clearAsk(this.storage, self.addr, myAsk.askId);
  }

  // ── Tool actions ───────────────────────────────────────────────────────

  /**
   * JSON listing of visible agents, including self (marked `self: true`).
   * Grouped agents see only their co-members; an agent in no group sees
   * only itself. Every visible record is listed, live or offline; presence
   * decides the per-agent status.
   */
  async list(): Promise<string> {
    const self = this.requireSelf();
    const all = await listRecords(this.storage);
    const memberIds = await this.myGroupMemberIds();
    const records = all.filter((r) => {
      if (r.addr === self.addr) return !this.dead;
      return memberIds?.has(r.agentId) ?? false;
    });
    return formatListing(records, self.addr, presenceOf);
  }

  /** Same as list(), filtered to one working directory. */
  async listCwd(cwd: string): Promise<string> {
    const self = this.requireSelf();
    const records = await listRecords(this.storage);
    const memberIds = await this.myGroupMemberIds();
    const filtered = records.filter((r) => {
      if (r.cwd !== cwd) return false;
      if (r.addr === self.addr) return !this.dead;
      return memberIds?.has(r.agentId) ?? false;
    });
    return formatListing(filtered, self.addr, presenceOf);
  }

  /** Visible peer records (excluding self), e.g. for command completions. */
  async listPeers(): Promise<AgentRecord[]> {
    const self = this.requireSelf();
    const records = await listRecords(this.storage);
    const memberIds = await this.myGroupMemberIds();
    return records.filter((r) => r.addr !== self.addr && (memberIds?.has(r.agentId) ?? false));
  }

  /**
   * Mark an agent as dead: set its offline flag and pin lastSeenAt to 0 so
   * the next sweep reaps it (empty mailbox). Without a target, marks this
   * agent — later writeSelf calls no longer refresh lastSeenAt, and the
   * record stays offline for peers.
   */
  async markDead(target?: string): Promise<string> {
    if (!target) {
      this.dead = true;
      await this.writeSelf({ offline: true });
      return "Marked this agent as dead.";
    }
    const resolved = await this.resolveTarget(target);
    if (!resolved.ok) return resolved.error;
    await writeRecord(this.storage, { ...resolved.record, lastSeenAt: 0, offline: true });
    return `Marked "${resolved.record.name}" as dead.`;
  }

  /** Mark every visible peer (except self) as dead. */
  async markAllDead(): Promise<string> {
    const peers = await this.listPeers();
    for (const peer of peers) {
      await writeRecord(this.storage, { ...peer, lastSeenAt: 0, offline: true });
    }
    return `Marked ${peers.length} agent(s) as dead.`;
  }

  // ── Groups ─────────────────────────────────────────────────────────────

  /** Remove the caller from its current group, deleting the group when it empties. */
  private async leaveCurrentGroup(): Promise<boolean> {
    const self = this.requireSelf();
    const group = await groupForAgent(this.storage, self.agentId);
    if (!group) return false;
    const others = group.members.filter((m) => m !== self.agentId);
    if (others.length === 0) {
      await deleteGroup(this.storage, group.id);
    } else {
      await writeGroup(this.storage, { ...group, members: others, updatedAt: this.now() });
    }
    return true;
  }

  /**
   * Join or create a group and join it. With no name a fresh uuid is
   * generated; with a name, the group is joined when it exists and created
   * otherwise. Leaving any current group first keeps the single-group
   * invariant. When `agentName` is given, the agent's display name (what
   * peers see in talk-list-agents) is set to it — also when the agent is
   * already in the group, so re-joining can rename.
   */
  async groupJoin(groupName?: string, agentName?: string): Promise<string> {
    const self = this.requireSelf();
    const name =
      groupName === undefined || groupName.trim() === "" ? newGroupId() : groupName.trim();
    if (!isValidGroupName(name)) {
      return `Invalid group name '${name}'. Allowed: letters, digits, '-' and '_' (max 64 chars).`;
    }
    if (agentName !== undefined) {
      await this.writeSelf({ name: agentName, alias: agentName });
    }
    const nameNote = agentName === undefined ? "" : ` You are visible as "${agentName}".`;
    const existing = await readGroup(this.storage, name);
    if (existing?.members.includes(self.agentId)) {
      return `Already in group ${name} (${existing.members.length} member(s)).${nameNote}`;
    }
    await this.leaveCurrentGroup();
    if (existing) {
      await writeGroup(this.storage, {
        ...existing,
        members: [...existing.members, self.agentId],
        updatedAt: this.now(),
      });
      return `Joined group ${name} (${existing.members.length + 1} member(s)). You now see only co-members.${nameNote}`;
    }
    const now = this.now();
    await writeGroup(this.storage, {
      id: name,
      members: [self.agentId],
      createdAt: now,
      updatedAt: now,
    });
    return `Created group ${name}.${nameNote} Other agents join it with /talk-group-join ${name}.`;
  }

  /**
   * Join the most recently created group; no-op when already in it. When
   * `agentName` is given, the agent's display name is set to it.
   */
  async groupJoinLast(agentName?: string): Promise<string> {
    const groups = await listGroups(this.storage);
    if (groups.length === 0) return "No groups. Create one with /talk-group-join.";
    const latest = groups.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    return this.groupJoin(latest.id, agentName);
  }

  /** Leave the current group; an emptied group is deleted. */
  async groupLeave(): Promise<string> {
    const self = this.requireSelf();
    const group = await groupForAgent(this.storage, self.agentId);
    if (!group) return "Not in any group.";
    const others = group.members.filter((m) => m !== self.agentId);
    if (others.length === 0) {
      await deleteGroup(this.storage, group.id);
      return `Left group ${group.id} (deleted — it was empty).`;
    }
    await writeGroup(this.storage, { ...group, members: others, updatedAt: this.now() });
    return `Left group ${group.id} (${others.length} member(s) remain).`;
  }

  /** Delete a group by name; its members become ungrouped. */
  async groupDelete(groupName: string): Promise<string> {
    const name = groupName.trim();
    if (!isValidGroupName(name)) return `Invalid group name '${name}'.`;
    const group = await readGroup(this.storage, name);
    if (!group) return `Unknown group '${name}'. Run /talk-group-list to see groups.`;
    await deleteGroup(this.storage, name);
    return `Deleted group ${name} (${group.members.length} member(s)).`;
  }

  /** Delete every group; all agents become ungrouped. */
  async groupClear(): Promise<string> {
    const groups = await listGroups(this.storage);
    for (const group of groups) await deleteGroup(this.storage, group.id);
    return groups.length === 0 ? "No groups." : `Deleted ${groups.length} group(s).`;
  }

  /**
   * Human-readable listing of every group and its members (management view).
   * Newest first — the oldest group is listed last.
   */
  async groupList(): Promise<string> {
    const self = this.requireSelf();
    const groups = await listGroups(this.storage);
    if (groups.length === 0) return "No groups.";
    const records = await listRecords(this.storage);
    const label = (agentId: string): string => {
      const rec = records.find((r) => r.agentId === agentId);
      const id = agentId.length > 8 ? `${agentId.slice(0, 8)}…` : agentId;
      return rec ? `${rec.name} (${id})` : `unknown agent (${id})`;
    };
    const lines = groups
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .map((g) => {
        const members = g.members.map((m) => (m === self.agentId ? `${label(m)} ← you` : label(m)));
        return `- ${g.id} (created ${age(g.createdAt)}): ${members.join(", ")}`;
      });
    return `Groups (${groups.length}):\n${lines.join("\n")}`;
  }

  /**
   * Status-bar text for the caller: "alias@group" when an explicit alias was
   * set via `talk-group-join --name`, "@group" otherwise; undefined when the
   * caller is in no group (the adapter clears its status bar).
   */
  async groupStatus(): Promise<string | undefined> {
    const self = this.requireSelf();
    const group = await groupForAgent(this.storage, self.agentId);
    if (!group) return undefined;
    return self.alias ? `${self.alias}@${group.id}` : `@${group.id}`;
  }

  async send(to: string, body: string): Promise<string> {
    if (!to) return 'send requires "to".';
    if (!body) return 'send requires "message".';
    if (to === "*" || to === "cwd") {
      return "send requires a single agent id; broadcasting is disabled.";
    }
    const resolved = await this.resolveTarget(to);
    if (!resolved.ok) return resolved.error;
    const sent = await this.sendLetter(resolved.record, "message", body);
    if (!sent.ok) return sent.error;
    return `Sent to "${resolved.record.name}" (${shortAddr(resolved.record.addr)}) [id ${sent.letter.id.slice(-8)}]: ${sent.verdict}.`;
  }

  async ask(to: string, body: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (!to) return 'ask requires "to".';
    if (!body) return 'ask requires "message".';
    if (to === "*" || to === "cwd") {
      return "ask is 1:1 and cannot broadcast.";
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
    this.setWaiting();
    try {
      const outcome = await this.waitForReply(sent.letter.id, Math.max(1000, timeoutMs), signal);
      await clearAsk(this.storage, self.addr, sent.letter.id);
      if (!outcome.replied)
        return `Ask ${sent.letter.id.slice(-8)} to "${record.name}": ${outcome.reason}.`;
      return `"${record.name}" replied:\n\n${outcome.body}`;
    } finally {
      // The ask tool call is still part of a running agent turn.
      this.setWorking();
    }
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
    return `Replied to "${target.name}" (ask ${ask.id.slice(-8)}): ${sent.verdict}.`;
  }

  /** Build a minimal record from a letter's sender when the peer record is gone. */
  private recordFromLetter(letter: Letter): AgentRecord {
    return {
      addr: letter.from.addr,
      agentId: letter.from.agentId,
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
      const state = now === "live" ? (rec?.status ?? "idle") : "offline";
      this.events.notify(`talk watch: ${label} is now ${state}.`);
    }
  }
}
