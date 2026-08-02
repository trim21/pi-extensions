/**
 * Tests for `pollChecksResult` — the polling core of `read-github-pr-status`.
 *
 * `gh pr checks` exits 8 when checks are pending — that is a state, not an
 * error. The tool must poll every 30s until checks fail (exit 1) or all pass
 * (exit 0), and only throw for real errors.
 *
 * Run: npx vitest run test/pr-status.test.ts
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { pollChecksResult } from "../src/gh-readonly.js";

const PENDING = { code: 8, stdout: "pending table" };
const PASSED = { code: 0, stdout: "passed table" };
const FAILED = { code: 1, stdout: "failed table" };

afterEach(() => {
  vi.useRealTimers();
});

describe("pollChecksResult", () => {
  it("returns immediately when all checks pass (exit 0)", async () => {
    const query = vi.fn().mockResolvedValue(PASSED);
    const result = await pollChecksResult(query);
    expect(result).toEqual(PASSED);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when a check fails (exit 1), no polling", async () => {
    const query = vi.fn().mockResolvedValue(FAILED);
    const result = await pollChecksResult(query);
    expect(result).toEqual(FAILED);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("polls every 30s while pending (exit 8) until all checks pass", async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(PASSED);

    const promise = pollChecksResult(query);
    await vi.advanceTimersByTimeAsync(0); // first gh call resolves
    await vi.advanceTimersByTimeAsync(30_000); // sleep 1
    await vi.advanceTimersByTimeAsync(30_000); // sleep 2

    const result = await promise;
    expect(result).toEqual(PASSED);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("polls while pending and reports failure once a check fails (exit 1)", async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockResolvedValueOnce(PENDING).mockResolvedValueOnce(FAILED);

    const promise = pollChecksResult(query);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;
    expect(result).toEqual(FAILED);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("stops polling and returns the current table after the timeout", async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockResolvedValue(PENDING);

    const promise = pollChecksResult(query, { intervalMs: 30_000, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000); // poll 2
    await vi.advanceTimersByTimeAsync(30_000); // poll 3, deadline passed

    const result = await promise;
    expect(result).toEqual(PENDING);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("returns a real error exit code immediately without polling it", async () => {
    const query = vi.fn().mockResolvedValue({ code: 4, stdout: "" });
    const result = await pollChecksResult(query);
    expect(result.code).toBe(4);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("throws when aborted while waiting on pending checks", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const query = vi.fn().mockResolvedValue(PENDING);

    const promise = pollChecksResult(query, {
      signal: controller.signal,
      intervalMs: 30_000,
      timeoutMs: 600_000,
    });
    await vi.advanceTimersByTimeAsync(0); // first gh call resolves, sleep starts
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/);
  });
});
