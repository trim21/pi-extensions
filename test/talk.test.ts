/**
 * Tests for the talk core layer (storage, registry, mailbox, policy,
 * format) and the mutual-ask arbitration. The pi adapter (index.ts) is not
 * exercised here — it is a thin binding to pi APIs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildVisibilityFilter, peerAskedFirst, TalkCore } from "../src/talk/core.js";
import { BOUNDARY_PREAMBLE, formatDelivery, formatListing } from "../src/talk/format.js";
import {
  awaitReceipt,
  clearAsk,
  deposit,
  type Letter,
  listInbox,
  newMessageId,
  pendingAsks,
  previewBody,
  readAudit,
  removeLetter,
  resolveAskByRef,
  trackIncomingAsk,
  trackOutgoingAsk,
} from "../src/talk/mailbox.js";
import { BACKLOG_CAP, OutboundPolicy } from "../src/talk/policy.js";
import {
  deriveAddr,
  listRecords,
  presenceOf,
  readRecord,
  type SessionRecord,
  sweep,
  writeRecord,
} from "../src/talk/registry.js";
import { SqliteTalkStorage, type TalkStorage } from "../src/talk/storage.js";

const dirs: string[] = [];

function makeStorage(): { storage: SqliteTalkStorage } {
  const dir = mkdtempSync(join(tmpdir(), "talk-test-"));
  dirs.push(dir);
  return { storage: new SqliteTalkStorage(join(dir, "talk.db")) };
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function makeLetter(overrides: Partial<Letter> = {}): Letter {
  return {
    id: newMessageId(),
    from: { addr: "aaaaaaaaaaaa", name: "A", cwd: "/tmp/a", sessionId: "session-a" },
    kind: "message",
    body: "hello",
    ts: Date.now(),
    ...overrides,
  };
}

function makeSelf(addr: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    addr,
    sessionId: `session-${addr}`,
    name: `session ${addr}`,
    cwd: `/tmp/${addr}`,
    pid: process.pid,
    startedAt: Date.now(),
    lastSeenAt: Date.now(),
    status: "idle",
    ...overrides,
  };
}

// ── Storage ──────────────────────────────────────────────────────────────

describe("SqliteTalkStorage", () => {
  it("writes, reads, lists, and removes JSON values", async () => {
    const { storage } = makeStorage();
    await storage.init();
    await storage.writeJson("ns", "b", { x: 2 });
    await storage.writeJson("ns", "a", { x: 1 });
    expect(await storage.listKeys("ns")).toEqual(["a", "b"]);
    expect(await storage.readJson("ns", "a")).toEqual({ x: 1 });
    expect(await storage.hasKeys("ns")).toBe(true);
    expect(await storage.removeKey("ns", "a")).toBe(true);
    expect(await storage.removeKey("ns", "a")).toBe(false);
    expect(await storage.readJson("ns", "missing")).toBeNull();
    expect(await storage.readJson("other", "a")).toBeNull();
    await storage.removeNamespace("ns");
    expect(await storage.hasKeys("ns")).toBe(false);
  });

  it("appends and reads log lines in order", async () => {
    const { storage } = makeStorage();
    await storage.appendLog("audit", "first");
    await storage.appendLog("audit", "second");
    expect(await storage.readLog("audit")).toEqual(["first", "second"]);
    expect(await storage.readLog("absent")).toEqual([]);
  });
});

// ── Registry ─────────────────────────────────────────────────────────────

describe("registry", () => {
  it("derives a stable 12-hex address from cwd + sessionId", () => {
    const addr = deriveAddr("/tmp/x", "id");
    expect(addr).toMatch(/^[a-f0-9]{12}$/);
    expect(deriveAddr("/tmp/x", "id")).toBe(addr);
    expect(deriveAddr("/tmp/x", "id2")).not.toBe(addr);
  });

  it("round-trips session records", async () => {
    const { storage } = makeStorage();
    const self = makeSelf("aaaaaaaaaaaa");
    await writeRecord(storage, self);
    expect(await readRecord(storage, self.addr)).toEqual(self);
    expect(await readRecord(storage, "bbbbbbbbbbbb")).toBeNull();
  });

  it("presence reflects offline flag, pid, and heartbeat", async () => {
    const base = makeSelf("aaaaaaaaaaaa");
    expect(presenceOf({ ...base, offline: true })).toBe("offline");
    // pid 0 is never alive
    expect(presenceOf({ ...base, pid: 0 })).toBe("offline");
    expect(presenceOf({ ...base, lastSeenAt: Date.now() })).toBe("live");
    expect(presenceOf({ ...base, lastSeenAt: Date.now() - 60_000 })).toBe("stalled");
  });

  it("sweep keeps recent records and mail, reaps long-quiet empty ones", async () => {
    const { storage } = makeStorage();
    const now = Date.now();
    const recent = makeSelf("aaaaaaaaaaaa", { lastSeenAt: now - 1000 }); // heartbeat 1s ago
    const quietEmpty = makeSelf("bbbbbbbbbbbb", { lastSeenAt: now - 25 * 3600 * 1000 });
    const quietWithMail = makeSelf("cccccccccccc", { lastSeenAt: now - 25 * 3600 * 1000 });
    const ancient = makeSelf("dddddddddddd", { lastSeenAt: now - 31 * 24 * 3600 * 1000 });
    await writeRecord(storage, recent);
    await writeRecord(storage, quietEmpty);
    await writeRecord(storage, quietWithMail);
    await writeRecord(storage, ancient);
    await deposit(storage, quietWithMail.addr, makeLetter());
    await deposit(storage, ancient.addr, makeLetter());

    await sweep(storage, now);

    const records = await listRecords(storage);
    const addrs = records.map((r) => r.addr);
    expect(addrs).toContain("aaaaaaaaaaaa"); // heartbeat still fresh → untouched
    expect(addrs).not.toContain("bbbbbbbbbbbb"); // quiet > 24h + empty → reaped
    expect(addrs).toContain("cccccccccccc"); // quiet but has undelivered mail → kept
    expect(addrs).not.toContain("dddddddddddd"); // mail older than 30 days → reaped
  });
});

// ── Mailbox ──────────────────────────────────────────────────────────────

describe("mailbox", () => {
  it("deposits, lists, and removes letters", async () => {
    const { storage } = makeStorage();
    const letter = makeLetter();
    await deposit(storage, "bbbbbbbbbbbb", letter);
    const inbox = await listInbox(storage, "bbbbbbbbbbbb");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].letter.id).toBe(letter.id);
    expect(await removeLetter(storage, "bbbbbbbbbbbb", inbox[0].fileName)).toBe(true);
    expect(await listInbox(storage, "bbbbbbbbbbbb")).toEqual([]);
  });

  it("skips corrupt letters instead of poisoning the inbox", async () => {
    const { storage } = makeStorage();
    // Write an invalid payload directly to the inbox namespace.
    await storage.writeJson("inbox/bbbbbbbbbbbb", "1-bad.json", { id: "no-body" });
    expect(await listInbox(storage, "bbbbbbbbbbbb")).toEqual([]);
  });

  it("tracks asks, lists pending, and resolves by ref", async () => {
    const { storage } = makeStorage();
    const ask = makeLetter({ kind: "ask", body: "question?" });
    await trackIncomingAsk(storage, "bbbbbbbbbbbb", ask);
    await trackOutgoingAsk(storage, "bbbbbbbbbbbb", {
      askId: ask.id,
      toAddr: ask.from.addr,
      body: "question?",
      ts: ask.ts,
    });
    const pending = await pendingAsks(storage, "bbbbbbbbbbbb");
    expect(pending.map((a) => a.id)).toEqual([ask.id]);
    expect(await resolveAskByRef(storage, "bbbbbbbbbbbb", ask.id.slice(0, 8))).not.toBeNull();
    expect(await resolveAskByRef(storage, "bbbbbbbbbbbb", "nope")).toBeNull();
    await clearAsk(storage, "bbbbbbbbbbbb", ask.id);
    expect(await pendingAsks(storage, "bbbbbbbbbbbb")).toEqual([]);
  });

  it("audits deposits with a preview, never the full body", async () => {
    const { storage } = makeStorage();
    const body = "x".repeat(500);
    await deposit(storage, "bbbbbbbbbbbb", makeLetter({ body }));
    const audit = await readAudit(storage);
    expect(audit).toHaveLength(1);
    expect(audit[0].event).toBe("deposit");
    expect(audit[0].preview.length).toBeLessThanOrEqual(80);
  });

  it("previewBody collapses whitespace and strips ANSI", () => {
    expect(previewBody("  a\n  b  ")).toBe("a b");
    expect(previewBody("\u001B[31mred\u001B[0m")).toBe("red");
  });

  it("awaitReceipt resolves delivered once the letter is removed", async () => {
    const { storage } = makeStorage();
    const letter = makeLetter();
    await deposit(storage, "bbbbbbbbbbbb", letter);
    const receiptPromise = awaitReceipt(storage, "bbbbbbbbbbbb", letter, 1000);
    const inbox = await listInbox(storage, "bbbbbbbbbbbb");
    await removeLetter(storage, "bbbbbbbbbbbb", inbox[0].fileName);
    expect(await receiptPromise).toBe("delivered");
  });
});

// ── Policy ───────────────────────────────────────────────────────────────

describe("OutboundPolicy", () => {
  it("caps body size", () => {
    const policy = new OutboundPolicy();
    const verdict = policy.check("x".repeat(33_000), 0);
    expect(verdict.ok).toBe(false);
  });

  it("caps unread backlog", () => {
    const policy = new OutboundPolicy();
    const verdict = policy.check("hi", BACKLOG_CAP);
    expect(verdict.ok).toBe(false);
  });

  it("dedupes identical bodies to the same peer", () => {
    const policy = new OutboundPolicy();
    expect(policy.check("hello", 0, "peer").ok).toBe(true);
    policy.recordSend("hello", "peer");
    expect(policy.check("hello", 0, "peer").ok).toBe(false);
    expect(policy.check("hello", 0, "other").ok).toBe(true);
  });

  it("rate limits total fan-out", () => {
    const policy = new OutboundPolicy();
    for (let i = 0; i < 8; i++) {
      expect(policy.check(`msg ${i}`, 0).ok).toBe(true);
      policy.recordSend(`msg ${i}`);
    }
    expect(policy.check("one more", 0).ok).toBe(false);
  });
});

// ── Format ───────────────────────────────────────────────────────────────

describe("format", () => {
  it("formatDelivery carries the authority boundary and the body", () => {
    const text = formatDelivery(makeLetter({ kind: "ask", body: "the question" }));
    expect(text).toContain(BOUNDARY_PREAMBLE);
    expect(text).toContain("the question");
    expect(text).toContain("talk-reply");
  });

  it("formatListing emits a JSON array with stable session ids", () => {
    const records: SessionRecord[] = [
      makeSelf("aaaaaaaaaaaa", {
        sessionId: "0193a2f5-7c4b-8c1d-9e0f-abcdef123456",
        name: "peer-a",
        cwd: "/tmp/proj-a",
        status: "working",
      }),
      makeSelf("bbbbbbbbbbbb", {
        sessionId: "0193a2f6-1111-2222-3333-444444444444",
        name: "peer-b",
        cwd: "/tmp/proj-b",
        status: "idle",
      }),
    ];
    const listing = formatListing(records, "cccccccccccc", (r) =>
      r.status === "working" ? "live" : "stalled",
    );
    expect(JSON.parse(listing)).toEqual([
      {
        status: "working",
        work_dir: "/tmp/proj-a",
        id: "0193a2f5-7c4b-8c1d-9e0f-abcdef123456",
        name: "peer-a",
      },
      {
        status: "not responding",
        work_dir: "/tmp/proj-b",
        id: "0193a2f6-1111-2222-3333-444444444444",
        name: "peer-b",
      },
    ]);
  });

  it("formatListing returns an empty array when no peers exist", () => {
    expect(formatListing([makeSelf("aaaaaaaaaaaa")], "aaaaaaaaaaaa", () => "live")).toBe("[]");
  });

  it("formatListing surfaces the waiting-talk-message status", () => {
    const listing = formatListing(
      [makeSelf("aaaaaaaaaaaa", { status: "waiting-talk-message" })],
      "bbbbbbbbbbbb",
      () => "live",
    );
    expect(JSON.parse(listing)).toEqual([
      {
        status: "waiting-talk-message",
        work_dir: "/tmp/aaaaaaaaaaaa",
        id: "session-aaaaaaaaaaaa",
        name: "session aaaaaaaaaaaa",
      },
    ]);
  });
});

// ── Arbitration ──────────────────────────────────────────────────────────

describe("peerAskedFirst", () => {
  const peer = { ts: 100, cwd: "/x", sessionId: "a" };
  const self = { ts: 200, cwd: "/y", sessionId: "b" };

  it("earlier ts wins", () => {
    expect(peerAskedFirst(peer, self)).toBe(true);
    expect(peerAskedFirst(self, peer)).toBe(false);
  });

  it("breaks a same-ts tie deterministically by cwd + sessionId", () => {
    const left = { ts: 100, cwd: "/a", sessionId: "s" };
    const right = { ts: 100, cwd: "/b", sessionId: "s" };
    expect(peerAskedFirst(left, right)).toBe(true);
    expect(peerAskedFirst(right, left)).toBe(false);
  });

  it("never agrees in both directions", () => {
    const a = { ts: 1, cwd: "/a", sessionId: "1" };
    const b = { ts: 1, cwd: "/b", sessionId: "2" };
    expect(peerAskedFirst(a, b)).toBe(!peerAskedFirst(b, a));
  });
});

// ── Workspace visibility ─────────────────────────────────────────────────

describe("buildVisibilityFilter", () => {
  it("matches allowed prefixes without crossing directory boundaries", () => {
    const filter = buildVisibilityFilter(["/home/u/projects/company1/"], "/base");
    expect(filter("/home/u/projects/company1")).toBe(true);
    expect(filter("/home/u/projects/company1/repo")).toBe(true);
    expect(filter("/home/u/projects/company2/repo")).toBe(false);
    expect(filter("/home/u/projects/company12/repo")).toBe(false);
  });

  it("expands ~ and resolves relative paths against the base cwd", () => {
    const filter = buildVisibilityFilter(
      ["~/projects/company1", "../company1/"],
      "/home/u/projects/company2",
    );
    expect(filter(join(homedir(), "projects/company1/repo"))).toBe(true);
    expect(filter("/home/u/projects/company1/repo")).toBe(true);
  });

  it("treats a missing allowed list as everything visible and an empty list as nothing", () => {
    expect(buildVisibilityFilter(undefined, "/base")("/anywhere")).toBe(true);
    expect(buildVisibilityFilter([], "/base")("/anywhere")).toBe(false);
  });
});

// ── Core integration ─────────────────────────────────────────────────────

function makeCore(storage: TalkStorage, delivered: Letter[], now?: () => number): TalkCore {
  return new TalkCore({
    storage,
    events: {
      deliver: (letter) => {
        delivered.push(letter);
        return true;
      },
      notify: () => {
        // presence notifications are not asserted in these tests
      },
    },
    now,
  });
}

describe("TalkCore", () => {
  it("ask/reply round-trips between two cores", async () => {
    const { storage } = makeStorage();
    const deliveredB: Letter[] = [];
    const coreA = makeCore(storage, []);
    const coreB = makeCore(storage, deliveredB);
    await coreA.start(makeSelf("aaaaaaaaaaaa"));
    await coreB.start(makeSelf("bbbbbbbbbbbb"));

    const askPromise = coreA.ask("session-bbbbbbbbbbbb", "question?", 5000);
    // Wait until the ask letter lands in B's inbox, then let B process it.
    await vi.waitFor(async () => {
      expect(await listInbox(storage, "bbbbbbbbbbbb")).toHaveLength(1);
    });
    await coreB.checkInbox();
    const ask = deliveredB.find((l) => l.kind === "ask");
    if (!ask) throw new Error("expected an ask to be delivered to B");
    const replyResult = await coreB.reply(ask.id, "the answer");
    expect(replyResult).toContain("delivered");

    await coreA.checkInbox();
    const askResult = await askPromise;
    expect(askResult).toContain("the answer");
  });

  it("ask refuses when the target already sent a message", async () => {
    const { storage } = makeStorage();
    const coreA = makeCore(storage, []);
    const coreB = makeCore(storage, []);
    await coreA.start(makeSelf("aaaaaaaaaaaa"));
    await coreB.start(makeSelf("bbbbbbbbbbbb"));

    // Deposit a message from B directly into A's inbox (as if it just landed
    // and A's poller has not consumed it yet).
    await deposit(
      storage,
      "aaaaaaaaaaaa",
      makeLetter({
        from: {
          addr: "bbbbbbbbbbbb",
          name: "session bbbbbbbbbbbb",
          cwd: "/tmp/bbbbbbbbbbbb",
          sessionId: "session-bbbbbbbbbbbb",
        },
      }),
    );
    const result = await coreA.ask("session-bbbbbbbbbbbb", "question?", 1000);
    expect(result).toContain("unread message(s)");
    expect(result).toContain("reply before asking");
  });

  it("list hides peers outside the allowed workspaces", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb", { cwd: "/tmp/company1/repo" }));
    await writeRecord(storage, makeSelf("cccccccccccc", { cwd: "/tmp/company2/repo" }));
    core.setPeerVisibility(buildVisibilityFilter(["/tmp/company1"], "/base"));
    const listing = JSON.parse(await core.list()) as { id: string }[];
    expect(listing.map((s) => s.id)).toEqual(["session-bbbbbbbbbbbb"]);
  });

  it("list hides stale sessions unless includeOffline is set", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb", { lastSeenAt: Date.now() }));
    await writeRecord(
      storage,
      makeSelf("cccccccccccc", { lastSeenAt: Date.now() - 60 * 60 * 1000 }),
    );

    const listing = JSON.parse(await core.list()) as { id: string }[];
    expect(listing.map((s) => s.id)).toEqual(["session-bbbbbbbbbbbb"]);

    const all = JSON.parse(await core.list(true)) as { id: string }[];
    expect(all.map((s) => s.id).toSorted()).toEqual([
      "session-bbbbbbbbbbbb",
      "session-cccccccccccc",
    ]);
  });

  it("rejects asks to invisible sessions even with the exact session id", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb", { cwd: "/tmp/company2/repo" }));
    core.setPeerVisibility(buildVisibilityFilter(["/tmp/company1"], "/base"));
    const result = await core.ask("session-bbbbbbbbbbbb", "question?", 1000);
    expect(result).toContain("Unknown session id");
  });

  it("markDead on self pins lastSeenAt to 0 even across later writes", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    expect(await core.markDead()).toContain("this session");
    core.setWorking(); // would normally refresh lastSeenAt
    await vi.waitFor(async () => {
      const rec = await readRecord(storage, "aaaaaaaaaaaa");
      expect(rec?.lastSeenAt).toBe(0);
    });
    const listing = JSON.parse(await core.list()) as { id: string }[];
    expect(listing).toEqual([]);
  });

  it("markDead by session id removes it from the default listing", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb"));
    expect(await core.markDead("session-bbbbbbbbbbbb")).toContain("session bbbbbbbbbbbb");
    const listing = JSON.parse(await core.list()) as { id: string }[];
    expect(listing).toEqual([]);
  });

  it("markAllDead marks every visible peer", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb"));
    await writeRecord(storage, makeSelf("cccccccccccc"));
    expect(await core.markAllDead()).toContain("2 session");
    const listing = JSON.parse(await core.list()) as { id: string }[];
    expect(listing).toEqual([]);
  });

  it("sweep reaps a dead session with an empty mailbox immediately", async () => {
    const { storage } = makeStorage();
    const now = Date.now();
    await writeRecord(storage, makeSelf("aaaaaaaaaaaa", { lastSeenAt: 0 }));
    await sweep(storage, now);
    const records = await listRecords(storage);
    expect(records.map((r) => r.addr)).not.toContain("aaaaaaaaaaaa");
  });

  it("wait reports status waiting-talk-message while blocked, then restores working", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    const pending = core.wait(300);
    await vi.waitFor(async () => {
      const rec = await readRecord(storage, "aaaaaaaaaaaa");
      expect(rec?.status).toBe("waiting-talk-message");
    });
    await pending;
    await vi.waitFor(async () => {
      const rec = await readRecord(storage, "aaaaaaaaaaaa");
      expect(rec?.status).toBe("working");
    });
  });
});
