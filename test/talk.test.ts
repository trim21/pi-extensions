/**
 * Tests for the talk core layer (storage, registry, mailbox, policy,
 * format) and the mutual-ask arbitration. The pi adapter (index.ts) is not
 * exercised here — it is a thin binding to pi APIs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { peerAskedFirst, TalkCore } from "../src/talk/core.js";
import { BOUNDARY_PREAMBLE, formatDelivery, formatListing } from "../src/talk/format.js";
import {
  deleteGroup,
  groupForAgent,
  listGroups,
  readGroup,
  writeGroup,
} from "../src/talk/group.js";
import {
  awaitReceipt,
  clearAsk,
  deposit,
  type Letter,
  listInbox,
  newMessageId,
  previewBody,
  readAudit,
  readOutgoingAsk,
  removeLetter,
  trackOutgoingAsk,
} from "../src/talk/mailbox.js";
import { BACKLOG_CAP, OutboundPolicy } from "../src/talk/policy.js";
import {
  type AgentRecord,
  deriveAddr,
  listRecords,
  presenceOf,
  readRecord,
  sweep,
  writeRecord,
} from "../src/talk/registry.js";
import { SqliteTalkStorage, type TalkStorage } from "../src/talk/storage.js";

const dirs: string[] = [];
const storages: SqliteTalkStorage[] = [];
const cores: TalkCore[] = [];

function makeStorage(): { storage: SqliteTalkStorage } {
  const dir = mkdtempSync(join(tmpdir(), "talk-test-"));
  dirs.push(dir);
  const storage = new SqliteTalkStorage(join(dir, "talk.db"));
  storages.push(storage);
  return { storage };
}

afterEach(async () => {
  // 顺序很重要：先停掉 core 的轮询定时器（否则会访问已关闭的 storage 并
  // 产生 unhandled rejection），再关闭 SQLite 句柄，最后删目录——Windows 上
  // 被占用的目录无法删除（EPERM）。
  await Promise.allSettled(cores.map((core) => core.stop()));
  cores.length = 0;
  for (const storage of storages) {
    storage.close();
  }
  storages.length = 0;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function makeLetter(overrides: Partial<Letter> = {}): Letter {
  return {
    id: newMessageId(),
    from: { addr: "aaaaaaaaaaaa", name: "A", cwd: "/tmp/a", agentId: "agent-a" },
    kind: "message",
    body: "hello",
    ts: Date.now(),
    ...overrides,
  };
}

function makeSelf(addr: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    addr,
    agentId: `agent-${addr}`,
    name: `agent ${addr}`,
    cwd: `/tmp/${addr}`,
    pid: process.pid,
    startedAt: Date.now(),
    lastSeenAt: Date.now(),
    status: "idle",
    ...overrides,
  };
}

/** This test process's own start time, from /proc/self/stat (Linux only). */
function selfStartTime(): number {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[19]);
}

/** Extract the group name from a groupJoin "Created group" result string. */
function groupIdFrom(result: string): string {
  const m = /Created group ([^\s.]+)/.exec(result);
  if (!m) throw new Error(`cannot parse group id from: ${result}`);
  return m[1];
}

/** Extract the group name from one line of a groupList output. */
function groupNameFromLine(line: string): string | undefined {
  return /^- (\S+) \(/.exec(line)?.[1];
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

  it("creates the parent directory when the db path folder is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "talk-test-"));
    dirs.push(dir);
    const nested = join(dir, "deep", "talk.db");
    const storage = new SqliteTalkStorage(nested);
    storage.close();
    expect(existsSync(nested)).toBe(true);
  });
});

// ── Registry ─────────────────────────────────────────────────────────────

describe("registry", () => {
  it("derives a stable 12-hex address from cwd + agentId", () => {
    const addr = deriveAddr("/tmp/x", "id");
    expect(addr).toMatch(/^[a-f0-9]{12}$/);
    expect(deriveAddr("/tmp/x", "id")).toBe(addr);
    expect(deriveAddr("/tmp/x", "id2")).not.toBe(addr);
  });

  it("round-trips agent records", async () => {
    const { storage } = makeStorage();
    const self = makeSelf("aaaaaaaaaaaa");
    await writeRecord(storage, self);
    expect(await readRecord(storage, self.addr)).toEqual(self);
    expect(await readRecord(storage, "bbbbbbbbbbbb")).toBeNull();
  });

  it("readRecord migrates legacy records that stored the id as sessionId", async () => {
    const { storage } = makeStorage();
    // Pre-rename shape: `sessionId` instead of `agentId`.
    const legacy = {
      addr: "aaaaaaaaaaaa",
      sessionId: "legacy-session-id",
      name: "old agent",
      cwd: "/tmp/legacy",
      pid: 0,
      startedAt: 1,
      lastSeenAt: 1,
      status: "idle",
    };
    await storage.writeJson("records", "aaaaaaaaaaaa.json", legacy);
    const rec = await readRecord(storage, "aaaaaaaaaaaa");
    expect(rec?.agentId).toBe("legacy-session-id");
    expect(rec?.name).toBe("old agent");
  });

  it("presence reflects the offline flag and pid liveness", () => {
    const base = makeSelf("aaaaaaaaaaaa");
    expect(presenceOf({ ...base, offline: true })).toBe("offline");
    // pid 0 is never alive
    expect(presenceOf({ ...base, pid: 0 })).toBe("offline");
    // a live process is live regardless of lastSeenAt (no heartbeat)
    expect(presenceOf(base)).toBe("live");
    expect(presenceOf({ ...base, lastSeenAt: 0 })).toBe("live");
  });

  it("presence treats a reused pid (start time mismatch) as offline", () => {
    if (process.platform !== "linux") return; // /proc start time is Linux-only
    const base = makeSelf("aaaaaaaaaaaa");
    const start = selfStartTime();
    expect(start).toBeGreaterThan(0);
    // matching start time → the same process → live
    expect(presenceOf({ ...base, pidStart: start })).toBe("live");
    // an alive pid with a different start time is a pid-reuse phantom → offline
    expect(presenceOf({ ...base, pidStart: start + 1 })).toBe("offline");
  });

  it("sweep keeps live and recent records and mail, reaps long-quiet dead empty ones", async () => {
    const { storage } = makeStorage();
    const now = Date.now();
    // pid 0 = process is dead; the test's own pid = process is alive.
    const liveQuiet = makeSelf("aaaaaaaaaaaa", { lastSeenAt: now - 25 * 3600 * 1000 });
    const deadRecent = makeSelf("bbbbbbbbbbbb", { pid: 0, lastSeenAt: now - 1000 });
    const deadQuietEmpty = makeSelf("cccccccccccc", { pid: 0, lastSeenAt: now - 25 * 3600 * 1000 });
    const deadQuietWithMail = makeSelf("dddddddddddd", {
      pid: 0,
      lastSeenAt: now - 25 * 3600 * 1000,
    });
    const deadAncient = makeSelf("eeeeeeeeeeee", {
      pid: 0,
      lastSeenAt: now - 31 * 24 * 3600 * 1000,
    });
    await writeRecord(storage, liveQuiet);
    await writeRecord(storage, deadRecent);
    await writeRecord(storage, deadQuietEmpty);
    await writeRecord(storage, deadQuietWithMail);
    await writeRecord(storage, deadAncient);
    await deposit(storage, deadQuietWithMail.addr, makeLetter());
    await deposit(storage, deadAncient.addr, makeLetter());

    await sweep(storage, now);

    const records = await listRecords(storage);
    const addrs = records.map((r) => r.addr);
    expect(addrs).toContain("aaaaaaaaaaaa"); // alive process → never reaped
    expect(addrs).toContain("bbbbbbbbbbbb"); // dead but quiet < 24h → untouched
    expect(addrs).not.toContain("cccccccccccc"); // dead, quiet > 24h + empty → reaped
    expect(addrs).toContain("dddddddddddd"); // dead, quiet but has undelivered mail → kept
    expect(addrs).not.toContain("eeeeeeeeeeee"); // mail older than 30 days → reaped
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

  it("listInbox migrates legacy letters whose sender id was sessionId", async () => {
    const { storage } = makeStorage();
    const legacy = {
      id: newMessageId(),
      from: { addr: "aaaaaaaaaaaa", name: "A", cwd: "/tmp/a", sessionId: "legacy-session" },
      kind: "message" as const,
      body: "hello from the past",
      ts: Date.now(),
    };
    await storage.writeJson("inbox/bbbbbbbbbbbb", "1-legacy.json", legacy);
    const inbox = await listInbox(storage, "bbbbbbbbbbbb");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].letter.from.agentId).toBe("legacy-session");
    expect(inbox[0].letter.body).toBe("hello from the past");
  });

  it("tracks outgoing asks and clears them", async () => {
    const { storage } = makeStorage();
    const ask = makeLetter({ kind: "ask", body: "question?" });
    await trackOutgoingAsk(storage, "bbbbbbbbbbbb", {
      askId: ask.id,
      toAddr: ask.from.addr,
      body: "question?",
      ts: ask.ts,
    });
    expect(await readOutgoingAsk(storage, "bbbbbbbbbbbb", ask.id)).not.toBeNull();
    await clearAsk(storage, "bbbbbbbbbbbb", ask.id);
    expect(await readOutgoingAsk(storage, "bbbbbbbbbbbb", ask.id)).toBeNull();
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
  it("formatDelivery marks the peer source and carries the body", () => {
    const text = formatDelivery(makeLetter({ kind: "ask", body: "the question" }));
    expect(text).toContain(BOUNDARY_PREAMBLE);
    expect(text).toContain("the question");
  });

  it("formatDelivery header carries the sender agent id", () => {
    const text = formatDelivery(makeLetter());
    expect(text).toContain('From pi agent agent-a (/tmp/a) — "A"');
  });

  it("formatListing emits a JSON array with stable agent ids", () => {
    const records: AgentRecord[] = [
      makeSelf("aaaaaaaaaaaa", {
        agentId: "0193a2f5-7c4b-8c1d-9e0f-abcdef123456",
        name: "peer-a",
        cwd: "/tmp/proj-a",
        status: "working",
      }),
      makeSelf("bbbbbbbbbbbb", {
        agentId: "0193a2f6-1111-2222-3333-444444444444",
        name: "peer-b",
        cwd: "/tmp/proj-b",
        status: "idle",
      }),
    ];
    const listing = formatListing(records, "cccccccccccc", (r) =>
      r.status === "working" ? "live" : "offline",
    );
    expect(JSON.parse(listing)).toEqual([
      {
        status: "working",
        work_dir: "/tmp/proj-a",
        id: "0193a2f5-7c4b-8c1d-9e0f-abcdef123456",
        name: "peer-a",
      },
      {
        status: "offline",
        work_dir: "/tmp/proj-b",
        id: "0193a2f6-1111-2222-3333-444444444444",
        name: "peer-b",
      },
    ]);
  });

  it("formatListing marks the calling agent with self: true", () => {
    const listing = formatListing(
      [makeSelf("aaaaaaaaaaaa"), makeSelf("bbbbbbbbbbbb")],
      "aaaaaaaaaaaa",
      () => "live",
    );
    const parsed = JSON.parse(listing) as { id: string; self?: boolean }[];
    expect(parsed[0].id).toBe("agent-aaaaaaaaaaaa");
    expect(parsed[0].self).toBe(true);
    expect(parsed[1].id).toBe("agent-bbbbbbbbbbbb");
    expect(parsed[1].self).toBeUndefined();
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
        id: "agent-aaaaaaaaaaaa",
        name: "agent aaaaaaaaaaaa",
      },
    ]);
  });
});

// ── Arbitration ──────────────────────────────────────────────────────────

describe("peerAskedFirst", () => {
  const peer = { ts: 100, cwd: "/x", agentId: "a" };
  const self = { ts: 200, cwd: "/y", agentId: "b" };

  it("earlier ts wins", () => {
    expect(peerAskedFirst(peer, self)).toBe(true);
    expect(peerAskedFirst(self, peer)).toBe(false);
  });

  it("breaks a same-ts tie deterministically by cwd + agentId", () => {
    const left = { ts: 100, cwd: "/a", agentId: "s" };
    const right = { ts: 100, cwd: "/b", agentId: "s" };
    expect(peerAskedFirst(left, right)).toBe(true);
    expect(peerAskedFirst(right, left)).toBe(false);
  });

  it("never agrees in both directions", () => {
    const a = { ts: 1, cwd: "/a", agentId: "1" };
    const b = { ts: 1, cwd: "/b", agentId: "2" };
    expect(peerAskedFirst(a, b)).toBe(!peerAskedFirst(b, a));
  });
});

// ── Groups ──────────────────────────────────────────────────────────────

describe("groups", () => {
  it("writes, lists, reads, and deletes groups", async () => {
    const { storage } = makeStorage();
    const now = Date.now();
    const group = { id: "g1", members: ["a", "b"], createdAt: now, updatedAt: now };
    await writeGroup(storage, group);
    expect(await listGroups(storage)).toEqual([group]);
    expect(await readGroup(storage, "g1")).toEqual(group);
    expect(await readGroup(storage, "missing")).toBeNull();
    expect(await deleteGroup(storage, "g1")).toBe(true);
    expect(await listGroups(storage)).toEqual([]);
  });

  it("skips corrupt group records", async () => {
    const { storage } = makeStorage();
    await storage.writeJson("groups", "bad.json", { nope: true });
    expect(await listGroups(storage)).toEqual([]);
  });

  it("groupForAgent finds the group containing the agent", async () => {
    const { storage } = makeStorage();
    await writeGroup(storage, { id: "g1", members: ["a", "b"], createdAt: 1, updatedAt: 1 });
    await writeGroup(storage, { id: "g2", members: ["c"], createdAt: 2, updatedAt: 2 });
    const groupOfB = await groupForAgent(storage, "b");
    const groupOfC = await groupForAgent(storage, "c");
    expect(groupOfB?.id).toBe("g1");
    expect(groupOfC?.id).toBe("g2");
    expect(await groupForAgent(storage, "nobody")).toBeNull();
  });

  it("groupJoin without a name creates a fresh group with a uuid", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    const result = await core.groupJoin();
    const id = groupIdFrom(result);
    expect(result).toContain(`/talk-group-join ${id}`);
    const myGroup = await groupForAgent(storage, "agent-aaaaaaaaaaaa");
    expect(myGroup?.id).toBe(id);
  });

  it("groupJoin with a custom name creates the group and a second agent joins it", async () => {
    const { storage } = makeStorage();
    const coreA = makeCore(storage, []);
    const coreB = makeCore(storage, []);
    await coreA.start(makeSelf("aaaaaaaaaaaa"));
    await coreB.start(makeSelf("bbbbbbbbbbbb"));
    const created = await coreA.groupJoin("abc");
    expect(created).toContain("Created group abc");
    expect(created).toContain("Members: agent aaaaaaaaaaaa");
    const joined = await coreB.groupJoin("abc");
    expect(joined).toContain("Joined group abc");
    // join result names the members so the model does not need a list call
    expect(joined).toContain("Members: agent aaaaaaaaaaaa");
    expect(joined).toContain("agent bbbbbbbbbbbb");
    const group = await readGroup(storage, "abc");
    expect(group?.members).toEqual(["agent-aaaaaaaaaaaa", "agent-bbbbbbbbbbbb"]);
  });

  it("groupJoin with a name like 'qwe--asd' works as a group name", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    expect(await core.groupJoin("qwe--asd")).toContain("Created group qwe--asd");
    const myGroup = await groupForAgent(storage, "agent-aaaaaaaaaaaa");
    expect(myGroup?.id).toBe("qwe--asd");
  });

  it("groupJoin refuses invalid group names", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    expect(await core.groupJoin("bad name")).toContain("Invalid group name");
    expect(await core.groupJoin("../escape")).toContain("Invalid group name");
    expect(await core.groupJoin("")).toContain("Created group"); // empty → uuid
  });

  it("groupJoin is idempotent for the current member", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await core.groupJoin("abc");
    expect(await core.groupJoin("abc")).toContain("Already in group");
  });

  it("groupJoin with a agent name sets the display name and lists it", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    const result = await core.groupJoin("abc", "frontend");
    expect(result).toContain("Created group abc");
    expect(result).toContain('visible as "frontend"');
    const rec = await readRecord(storage, "aaaaaaaaaaaa");
    expect(rec?.name).toBe("frontend");
    expect(rec?.alias).toBe("frontend");
    const listing = JSON.parse(await core.list()) as { name?: string }[];
    expect(listing[0].name).toBe("frontend");
  });

  it("groupStatus reflects the group and the explicit alias", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    // not in any group → no status text
    expect(await core.groupStatus()).toBeUndefined();
    // in a group without an alias → "@group"
    await core.groupJoin("abc");
    expect(await core.groupStatus()).toBe("@abc");
    // alias set via --name → "alias@group"
    await core.groupJoin("abc", "frontend");
    expect(await core.groupStatus()).toBe("frontend@abc");
  });

  it("groupStatus keeps the alias when moving groups without renaming", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await core.groupJoin("abc", "frontend");
    await core.groupJoin("xyz");
    expect(await core.groupStatus()).toBe("frontend@xyz");
  });

  it("groupJoin with a agent name renames an already-joined member", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await core.groupJoin("abc");
    expect(await core.groupJoin("abc", "backend")).toContain("Already in group");
    const rec = await readRecord(storage, "aaaaaaaaaaaa");
    expect(rec?.name).toBe("backend");
  });

  it("groupJoin without a agent name leaves the name untouched", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await core.groupJoin("abc", "frontend");
    await core.groupJoin("abc");
    const rec = await readRecord(storage, "aaaaaaaaaaaa");
    expect(rec?.name).toBe("frontend");
  });

  it("groupJoinLast joins the most recently created group", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    const now = Date.now();
    await writeGroup(storage, {
      id: "old",
      members: ["agent-bbbbbbbbbbbb"],
      createdAt: now - 2000,
      updatedAt: now - 2000,
    });
    await writeGroup(storage, {
      id: "new",
      members: ["agent-cccccccccccc"],
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });
    expect(await core.groupJoinLast()).toContain("Joined group new");
    expect(await core.groupJoinLast()).toContain("Members:");
    const myGroup = await groupForAgent(storage, "agent-aaaaaaaaaaaa");
    expect(myGroup?.id).toBe("new");
    // already in the newest group → no-op, still names the members
    const again = await core.groupJoinLast();
    expect(again).toContain("Already in group");
    expect(again).toContain("Members:");
    // no groups at all
    await core.groupClear();
    expect(await core.groupJoinLast()).toContain("No groups");
  });

  it("groupJoinLast with an agent name sets the display name", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    const now = Date.now();
    await writeGroup(storage, {
      id: "new",
      members: ["agent-bbbbbbbbbbbb"],
      createdAt: now,
      updatedAt: now,
    });
    const result = await core.groupJoinLast("frontend");
    expect(result).toContain('You are visible as "frontend".');
    const rec = await readRecord(storage, "aaaaaaaaaaaa");
    expect(rec?.name).toBe("frontend");
    // re-joining with a name renames the already-joined member
    const again = await core.groupJoinLast("backend");
    expect(again).toContain("Already in group");
    expect(again).toContain('You are visible as "backend".');
    const rec2 = await readRecord(storage, "aaaaaaaaaaaa");
    expect(rec2?.name).toBe("backend");
  });

  it("joining a new group leaves the old one (single group)", async () => {
    const { storage } = makeStorage();
    const coreA = makeCore(storage, []);
    const coreB = makeCore(storage, []);
    await coreA.start(makeSelf("aaaaaaaaaaaa"));
    await coreB.start(makeSelf("bbbbbbbbbbbb"));
    const g1 = groupIdFrom(await coreA.groupJoin());
    await coreB.groupJoin(g1);
    const g2 = groupIdFrom(await coreB.groupJoin());
    expect(g2).not.toBe(g1);
    const groupOfB = await groupForAgent(storage, "agent-bbbbbbbbbbbb");
    const groupOfA = await groupForAgent(storage, "agent-aaaaaaaaaaaa");
    expect(groupOfB?.id).toBe(g2);
    // A stays in g1, now alone
    expect(groupOfA?.id).toBe(g1);
    const g1After = await readGroup(storage, g1);
    expect(g1After?.members).toEqual(["agent-aaaaaaaaaaaa"]);
  });

  it("groupLeave removes the member and deletes an emptied group", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    const id = groupIdFrom(await core.groupJoin());
    expect(await core.groupLeave()).toContain("deleted");
    expect(await readGroup(storage, id)).toBeNull();
    expect(await core.groupLeave()).toContain("Not in any group");
  });

  it("groupLeave keeps a group with remaining members", async () => {
    const { storage } = makeStorage();
    const coreA = makeCore(storage, []);
    const coreB = makeCore(storage, []);
    await coreA.start(makeSelf("aaaaaaaaaaaa"));
    await coreB.start(makeSelf("bbbbbbbbbbbb"));
    const id = groupIdFrom(await coreA.groupJoin());
    await coreB.groupJoin(id);
    expect(await coreB.groupLeave()).toContain("1 member(s) remain");
    const gAfterLeave = await readGroup(storage, id);
    expect(gAfterLeave?.members).toEqual(["agent-aaaaaaaaaaaa"]);
  });

  it("groupDelete removes a group by name; members become ungrouped", async () => {
    const { storage } = makeStorage();
    const coreA = makeCore(storage, []);
    const coreB = makeCore(storage, []);
    await coreA.start(makeSelf("aaaaaaaaaaaa"));
    await coreB.start(makeSelf("bbbbbbbbbbbb"));
    await coreA.groupJoin("abc");
    await coreB.groupJoin("abc");
    expect(await coreA.groupDelete("abc")).toContain("Deleted group abc (2 member(s))");
    expect(await readGroup(storage, "abc")).toBeNull();
    expect(await groupForAgent(storage, "agent-aaaaaaaaaaaa")).toBeNull();
    expect(await groupForAgent(storage, "agent-bbbbbbbbbbbb")).toBeNull();
    expect(await coreA.groupDelete("missing")).toContain("Unknown group");
    expect(await coreA.groupDelete("bad name")).toContain("Invalid group name");
  });

  it("groupClear deletes every group", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeGroup(storage, {
      id: "g1",
      members: ["agent-bbbbbbbbbbbb"],
      createdAt: 1,
      updatedAt: 1,
    });
    await writeGroup(storage, {
      id: "g2",
      members: ["agent-cccccccccccc"],
      createdAt: 2,
      updatedAt: 2,
    });
    expect(await core.groupClear()).toContain("Deleted 2 group(s)");
    expect(await listGroups(storage)).toEqual([]);
    expect(await core.groupClear()).toContain("No groups");
  });

  it("groupList shows every group, newest first, and marks the caller", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await core.groupJoin("newest");
    const now = Date.now();
    await writeGroup(storage, {
      id: "oldest",
      members: ["agent-bbbbbbbbbbbb"],
      createdAt: now - 2000,
      updatedAt: now - 2000,
    });
    await writeGroup(storage, {
      id: "middle",
      members: ["agent-cccccccccccc"],
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb", { name: "peer-b" }));
    const text = await core.groupList();
    expect(text).toContain("Groups (3)");
    expect(text).toContain("← you");
    expect(text).toContain("peer-b");
    // Newest first — the oldest group is listed last.
    const lines = text.split("\n");
    expect(groupNameFromLine(lines[1])).toBe("newest");
    expect(groupNameFromLine(lines[2])).toBe("middle");
    expect(groupNameFromLine(lines[3])).toBe("oldest");
  });
});

// ── Core integration ─────────────────────────────────────────────────────

function makeCore(storage: TalkStorage, delivered: Letter[], now?: () => number): TalkCore {
  const core = new TalkCore({
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
  cores.push(core);
  return core;
}

describe("TalkCore", () => {
  it("ask is answered when the peer sends a message", async () => {
    const { storage } = makeStorage();
    const deliveredA: Letter[] = [];
    const deliveredB: Letter[] = [];
    const coreA = makeCore(storage, deliveredA);
    const coreB = makeCore(storage, deliveredB);
    await coreA.start(makeSelf("aaaaaaaaaaaa"));
    await coreB.start(makeSelf("bbbbbbbbbbbb"));
    await coreB.groupJoin(groupIdFrom(await coreA.groupJoin()));

    const askPromise = coreA.ask("agent-bbbbbbbbbbbb", "question?", 5000);
    // Wait until the ask letter lands in B's inbox, then let B process it.
    await vi.waitFor(async () => {
      expect(await listInbox(storage, "bbbbbbbbbbbb")).toHaveLength(1);
    });
    await coreB.checkInbox();
    expect(deliveredB.find((l) => l.kind === "ask")).toBeDefined();

    // B answers with a plain message (ask = send + wait; any peer message is
    // the response — the ask must not keep waiting until timeout).
    const sendResult = await coreB.send("agent-aaaaaaaaaaaa", "the answer");
    expect(sendResult).toContain("delivered");

    await coreA.checkInbox();
    const askResult = await askPromise;
    expect(askResult).toContain("peer sent a message in response");
    // the message itself is still handed to A's model
    expect(deliveredA.find((l) => l.kind === "message")?.body).toBe("the answer");
  });

  it("ask refuses when the target already sent a message", async () => {
    const { storage } = makeStorage();
    const coreA = makeCore(storage, []);
    const coreB = makeCore(storage, []);
    await coreA.start(makeSelf("aaaaaaaaaaaa"));
    await coreB.start(makeSelf("bbbbbbbbbbbb"));
    await coreB.groupJoin(groupIdFrom(await coreA.groupJoin()));

    // Deposit a message from B directly into A's inbox (as if it just landed
    // and A's poller has not consumed it yet).
    await deposit(
      storage,
      "aaaaaaaaaaaa",
      makeLetter({
        from: {
          addr: "bbbbbbbbbbbb",
          name: "agent bbbbbbbbbbbb",
          cwd: "/tmp/bbbbbbbbbbbb",
          agentId: "agent-bbbbbbbbbbbb",
        },
      }),
    );
    // Stop A's initialDrain/inboxPoll: otherwise they can consume the letter
    // between deposit and ask, the fast-path refusal never runs, and ask falls
    // into the ~4s awaitReceipt+waitForReply slow path — which flakes past
    // vitest's 5s timeout on slow Windows runners. stop() is idempotent, so
    // the afterEach cleanup still works. B stays live, changing nothing about
    // the scenario.
    await coreA.stop();
    const result = await coreA.ask("agent-bbbbbbbbbbbb", "question?", 1000);
    expect(result).toContain("unread message(s)");
    expect(result).toContain("respond to them before asking");
  });

  it("list shows only self when not in any group", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb", { cwd: "/tmp/company1/repo" }));
    await writeRecord(storage, makeSelf("cccccccccccc", { cwd: "/tmp/company2/repo" }));
    const listing = JSON.parse(await core.list()) as { id: string; self?: boolean }[];
    expect(listing).toHaveLength(1);
    expect(listing[0].id).toBe("agent-aaaaaaaaaaaa");
    expect(listing[0].self).toBe(true);
  });

  it("list shows every co-member, live or offline", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeGroup(storage, {
      id: "g1",
      members: ["agent-aaaaaaaaaaaa", "agent-bbbbbbbbbbbb", "agent-cccccccccccc"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb", { lastSeenAt: Date.now() }));
    await writeRecord(storage, makeSelf("cccccccccccc", { offline: true, lastSeenAt: 0 }));

    const listing = JSON.parse(await core.list()) as { id: string; status: string }[];
    expect(listing.map((s) => s.id).toSorted()).toEqual([
      "agent-aaaaaaaaaaaa",
      "agent-bbbbbbbbbbbb",
      "agent-cccccccccccc",
    ]);
    expect(listing.find((s) => s.id === "agent-cccccccccccc")?.status).toBe("offline");
  });

  it("grouped agents see only their co-members, ungrouped ones only themselves", async () => {
    const { storage } = makeStorage();
    const coreA = makeCore(storage, []);
    const coreB = makeCore(storage, []);
    const coreC = makeCore(storage, []);
    await coreA.start(makeSelf("aaaaaaaaaaaa"));
    await coreB.start(makeSelf("bbbbbbbbbbbb"));
    await coreC.start(makeSelf("cccccccccccc"));
    await coreB.groupJoin(groupIdFrom(await coreA.groupJoin()));

    const listA = JSON.parse(await coreA.list()) as { id: string }[];
    expect(listA.map((s) => s.id).toSorted()).toEqual(["agent-aaaaaaaaaaaa", "agent-bbbbbbbbbbbb"]);
    const listB = JSON.parse(await coreB.list()) as { id: string }[];
    expect(listB.map((s) => s.id).toSorted()).toEqual(["agent-aaaaaaaaaaaa", "agent-bbbbbbbbbbbb"]);
    const listC = JSON.parse(await coreC.list()) as { id: string }[];
    expect(listC.map((s) => s.id)).toEqual(["agent-cccccccccccc"]);
  });

  it("rejects asks to agents outside the group even with the exact agent id", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeGroup(storage, {
      id: "g1",
      members: ["agent-aaaaaaaaaaaa"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb", { cwd: "/tmp/company2/repo" }));
    const result = await core.ask("agent-bbbbbbbbbbbb", "question?", 1000);
    expect(result).toContain("Unknown agent id");
  });

  it("markDead on self pins lastSeenAt to 0 even across later writes", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    expect(await core.markDead()).toContain("this agent");
    core.setWorking(); // would normally refresh lastSeenAt
    await vi.waitFor(async () => {
      const rec = await readRecord(storage, "aaaaaaaaaaaa");
      expect(rec?.lastSeenAt).toBe(0);
      expect(rec?.offline).toBe(true);
    });
    const listing = JSON.parse(await core.list()) as { id: string }[];
    expect(listing).toEqual([]);
  });

  it("markDead by agent id marks the peer offline", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb"));
    await writeGroup(storage, {
      id: "g1",
      members: ["agent-aaaaaaaaaaaa", "agent-bbbbbbbbbbbb"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await core.markDead("agent-bbbbbbbbbbbb")).toContain("agent bbbbbbbbbbbb");
    const listing = JSON.parse(await core.list()) as { id: string; status: string }[];
    const peer = listing.find((s) => s.id === "agent-bbbbbbbbbbbb");
    expect(peer?.status).toBe("offline");
  });

  it("markAllDead marks every co-member but not self", async () => {
    const { storage } = makeStorage();
    const core = makeCore(storage, []);
    await core.start(makeSelf("aaaaaaaaaaaa"));
    await writeRecord(storage, makeSelf("bbbbbbbbbbbb"));
    await writeRecord(storage, makeSelf("cccccccccccc"));
    await writeGroup(storage, {
      id: "g1",
      members: ["agent-aaaaaaaaaaaa", "agent-bbbbbbbbbbbb", "agent-cccccccccccc"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await core.markAllDead()).toContain("2 agent");
    const listing = JSON.parse(await core.list()) as { id: string; status: string }[];
    const statuses = Object.fromEntries(listing.map((s) => [s.id, s.status]));
    expect(statuses).toEqual({
      "agent-aaaaaaaaaaaa": "idle",
      "agent-bbbbbbbbbbbb": "offline",
      "agent-cccccccccccc": "offline",
    });
  });

  it("sweep reaps a dead agent with an empty mailbox immediately", async () => {
    const { storage } = makeStorage();
    const now = Date.now();
    await writeRecord(storage, makeSelf("aaaaaaaaaaaa", { pid: 0, lastSeenAt: 0 }));
    await sweep(storage, now);
    const records = await listRecords(storage);
    expect(records.map((r) => r.addr)).not.toContain("aaaaaaaaaaaa");
  });
});
