/**
 * Tests for runGh/ghExec timeout and abort behavior.
 *
 * Regression: a process killed by the 30s default timeout used to resolve with
 * `code ?? 0` → 0, so ghExec treated the partial output as success and
 * `getJobLog` cached a truncated CI log as if it were complete (see session
 * 2026-08-06, run 31096396972 job 92599354966: the "build and run tests" step
 * log came back as checkout/submodule content).
 *
 * The fixes under test:
 *   - default timeout is now 10 minutes (600_000 ms), not 30s
 *   - a killed process resolves with a non-zero code and `reason` set
 *   - ghExec throws GhError (with a "timed out" marker) instead of succeeding
 *
 * Run: npx vitest run test/run-gh-timeout.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { GhError, ghExec, runGh } from "../src/gh-readonly.js";

/** A fake gh child process that never produces output and only exits when told. */
class FakeChildProcess extends EventEmitter {
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    // Mimic real behavior: a signal-killed process reports code=null on close.
    this.emit("close", null, _signal);
    return true;
  }

  exit(code: number): void {
    this.emit("close", code);
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

describe("runGh timeout", () => {
  it("a timed-out process is reported as killed with a non-zero code", async () => {
    const result = await runGh(["api", "slow-endpoint"], { timeout: 50 });
    expect(result.killed).toBe(true);
    expect(result.reason).toBe("timeout");
    expect(result.code).not.toBe(0);
    // -1 is the sentinel for "did not exit normally" (vs. gh's real failure code 1)
    expect(result.code).toBe(-1);
  });

  it("uses a 10-minute default timeout", async () => {
    vi.useFakeTimers();
    const promise = runGh(["api", "slow-endpoint"], {});
    vi.advanceTimersByTime(600_000);
    const result = await promise;
    expect(result.reason).toBe("timeout");
  });

  it("does not kill a process that exits before the timeout", async () => {
    const promise = runGh(["api", "fast"], { timeout: 50 });
    fakeProc.exit(0);
    const result = await promise;
    expect(result.killed).toBe(false);
    expect(result.code).toBe(0);
  });

  it("an aborted signal is reported as killed with reason=abort", async () => {
    const ac = new AbortController();
    const promise = runGh(["api", "x"], { signal: ac.signal, timeout: 10_000 });
    ac.abort();
    const result = await promise;
    expect(result.killed).toBe(true);
    expect(result.reason).toBe("abort");
    expect(result.code).toBe(-1);
  });
});

describe("ghExec timeout", () => {
  it("throws GhError instead of returning partial output as success", async () => {
    const err = await ghExec(["api", "slow-endpoint"], { timeout: 50 }).catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).message).toContain("command timed out");
    expect((err as GhError).code).toBe(-1);
  });
});
