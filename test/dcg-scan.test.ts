/**
 * Tests for `dcgSuggestion` — the optional dcg (Destructive Command Guard)
 * scan layer shown inside the full-access approval dialog.
 *
 * dcg output must never affect execution: every failure (not installed,
 * non-zero exit, timeout, unparseable output) degrades to `undefined` and the
 * approval dialog renders exactly as it would without dcg.
 *
 * Run: npx vitest run test/dcg-scan.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { dcgSuggestion } from "../src/bwrap/dcg-scan.js";

/** A fake dcg child process driven manually by each test. */
class FakeChildProcess extends EventEmitter {
  killed = false;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.emit("close", null, _signal);
    return true;
  }

  exit(code: number, stdout = ""): void {
    if (stdout) this.stdout.write(stdout);
    this.emit("close", code);
  }

  missing(): void {
    const err = new Error("spawn dcg ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    this.emit("error", err);
  }
}

let fakeProc: FakeChildProcess;

beforeEach(() => {
  fakeProc = new FakeChildProcess();
  spawnMock.mockReturnValue(fakeProc);
});

afterEach(() => {
  spawnMock.mockClear();
  vi.useRealTimers();
});

const denyOutput = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    decision: "deny",
    severity: "critical",
    rule_id: "core.git:reset-hard",
    reason: "git reset --hard destroys uncommitted changes",
    ...overrides,
  });

describe("dcgSuggestion", () => {
  it("returns undefined when dcg is not installed (ENOENT)", async () => {
    const promise = dcgSuggestion("rm -rf /");
    fakeProc.missing();
    await expect(promise).resolves.toBeUndefined();
  });

  it("returns a danger suggestion for a denied command", async () => {
    const promise = dcgSuggestion("git reset --hard");
    fakeProc.exit(0, denyOutput());

    const result = await promise;
    expect(result?.kind).toBe("danger");
    expect(result?.text).toContain("git reset --hard destroys uncommitted changes");
    expect(result?.text).toContain("core.git:reset-hard");
    expect(result?.text).toContain("critical");
  });

  it("escapes html in dcg-provided fields", async () => {
    const promise = dcgSuggestion("rm -rf /");
    fakeProc.exit(
      0,
      denyOutput({
        rule_id: "core.git:a<b",
        reason: "rm -rf <dangerous>",
      }),
    );

    const result = await promise;
    expect(result?.text).toContain("&lt;dangerous&gt;");
    expect(result?.text).toContain("core.git:a&lt;b");
  });

  it("returns a clean suggestion when the command is allowed", async () => {
    const promise = dcgSuggestion("git status");
    fakeProc.exit(0, JSON.stringify({ decision: "allow" }));

    const result = await promise;
    expect(result?.kind).toBe("clean");
    expect(result?.text).toContain("未检测到破坏性命令模式");
  });

  it("returns undefined when dcg exits non-zero", async () => {
    const promise = dcgSuggestion("git status");
    fakeProc.exit(1, "some error");

    await expect(promise).resolves.toBeUndefined();
  });

  it("returns undefined on unparseable output", async () => {
    const promise = dcgSuggestion("git status");
    fakeProc.exit(0, "not json at all");

    await expect(promise).resolves.toBeUndefined();
  });

  it("returns undefined when the verdict is indeterminate", async () => {
    const promise = dcgSuggestion("git status");
    fakeProc.exit(0, JSON.stringify({ decision: "indeterminate" }));

    await expect(promise).resolves.toBeUndefined();
  });

  it("returns undefined when dcg times out", async () => {
    vi.useFakeTimers();
    const promise = dcgSuggestion("rm -rf /");
    vi.advanceTimersByTime(2000);

    await expect(promise).resolves.toBeUndefined();
    expect(fakeProc.killed).toBe(true);
  });

  it("passes the command to dcg via stdin", async () => {
    const promise = dcgSuggestion("printf hi");
    fakeProc.exit(0, JSON.stringify({ decision: "allow" }));
    await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      "dcg",
      expect.arrayContaining(["--stdin", "--format", "json"]),
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });
});
