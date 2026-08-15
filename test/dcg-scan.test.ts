/**
 * Tests for `dcgSuggestion` — the optional dcg (Destructive Command Guard)
 * scan layer shown inside the full-access approval dialog.
 *
 * dcg output must never affect execution: a clean verdict is only a suggestion
 * text, and every failure degrades to an outcome the caller can act on
 * (`not-installed` = skip silently, `failed` = notify a warning).
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

import { type DcgSuggestion, dcgSuggestion } from "../src/bwrap/dcg-scan.js";

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

function expectSuggestion(result: Awaited<ReturnType<typeof dcgSuggestion>>): DcgSuggestion {
  expect(result.kind).toBe("suggestion");
  if (result.kind !== "suggestion") throw new Error("expected suggestion");
  return result.suggestion;
}

describe("dcgSuggestion", () => {
  it("reports not-installed when dcg is absent (ENOENT)", async () => {
    const promise = dcgSuggestion("rm -rf /");
    fakeProc.missing();

    await expect(promise).resolves.toEqual({ kind: "not-installed" });
  });

  it("returns a danger suggestion for a denied command", async () => {
    const promise = dcgSuggestion("git reset --hard");
    fakeProc.exit(0, denyOutput());

    const suggestion = expectSuggestion(await promise);
    expect(suggestion.kind).toBe("danger");
    expect(suggestion.text).toContain("git reset --hard destroys uncommitted changes");
    expect(suggestion.text).toContain("core.git:reset-hard");
    expect(suggestion.text).toContain("critical");
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

    const suggestion = expectSuggestion(await promise);
    expect(suggestion.text).toContain("&lt;dangerous&gt;");
    expect(suggestion.text).toContain("core.git:a&lt;b");
  });

  it("returns a clean suggestion when the command is allowed", async () => {
    const promise = dcgSuggestion("git status");
    fakeProc.exit(0, JSON.stringify({ decision: "allow" }));

    const suggestion = expectSuggestion(await promise);
    expect(suggestion.kind).toBe("clean");
    expect(suggestion.text).toContain("未检测到破坏性命令模式");
  });

  it("returns a danger suggestion even when dcg exits non-zero (deny verdict)", async () => {
    // dcg 的退出码是决策结果：deny 时返回 1，但 stdout 仍是有效 JSON
    const promise = dcgSuggestion("rm -rf /");
    fakeProc.exit(1, denyOutput());

    expect(expectSuggestion(await promise).kind).toBe("danger");
  });

  it("reports failed on non-zero exit with unusable output", async () => {
    const promise = dcgSuggestion("git status");
    fakeProc.exit(2, "");

    await expect(promise).resolves.toMatchObject({ kind: "failed" });
  });

  it("reports failed on unparseable output", async () => {
    const promise = dcgSuggestion("git status");
    fakeProc.exit(0, "not json at all");

    await expect(promise).resolves.toMatchObject({ kind: "failed" });
  });

  it("reports failed when the verdict is indeterminate", async () => {
    const promise = dcgSuggestion("git status");
    fakeProc.exit(0, JSON.stringify({ decision: "indeterminate" }));

    await expect(promise).resolves.toMatchObject({ kind: "failed" });
  });

  it("reports failed when dcg times out", async () => {
    vi.useFakeTimers();
    const promise = dcgSuggestion("rm -rf /");
    vi.advanceTimersByTime(2000);

    await expect(promise).resolves.toMatchObject({ kind: "failed" });
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
