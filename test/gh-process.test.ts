/**
 * Tests for the `gh` subprocess adapter (`src/lib/gh-process.ts`): `ghAuthToken`
 * must go through `runGh` with a 10-second timeout and map the three outcomes
 * (success, non-zero exit, spawn failure) to the messages the octokit clients
 * surfaced before the adapter was extracted.
 *
 * The `gh` process is faked, like in `test/run-gh-timeout.test.ts`.
 *
 * Run: npx vitest run test/gh-process.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { ghAuthToken } from "../src/lib/gh-process.js";

/** A fake gh child process that only answers when told. */
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

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

/** `gh auth token` 先解析代理配置再 spawn，发假事件前得等进程真的起来。 */
async function waitForSpawn(): Promise<void> {
  await vi.waitFor(() => {
    expect(spawnMock).toHaveBeenCalled();
  });
}

/** Spawn a fake process that answers with the given output and exit code. */
function respondWith(options: { stdout?: string; stderr?: string; code?: number }): void {
  spawnMock.mockImplementation(() => {
    const proc = new FakeChildProcess();
    setImmediate(() => {
      if (options.stdout) {
        proc.stdout.write(options.stdout);
      }
      if (options.stderr) {
        proc.stderr.write(options.stderr);
      }
      proc.emit("close", options.code ?? 0);
    });
    return proc;
  });
}

describe("ghAuthToken", () => {
  it("returns the trimmed token from stdout on success", async () => {
    respondWith({ stdout: "test-token\n", code: 0 });

    await expect(ghAuthToken()).resolves.toBe("test-token");
  });

  it("reports gh's stderr on a non-zero exit", async () => {
    respondWith({ stderr: "authentication required\n", code: 1 });

    await expect(ghAuthToken()).rejects.toThrow("authentication required");
  });

  it("falls back to an actionable message when a non-zero exit has no stderr", async () => {
    respondWith({ code: 1 });

    await expect(ghAuthToken()).rejects.toThrow(
      'gh auth token exited with code 1 — run "gh auth login" first',
    );
  });

  it("surfaces a spawn failure instead of an exit code", async () => {
    const fakeProc = new FakeChildProcess();
    spawnMock.mockReturnValue(fakeProc);
    const promise = ghAuthToken();
    await waitForSpawn();

    const rejection = expect(promise).rejects.toThrow("failed to start gh: spawn gh ENOENT");
    fakeProc.emit("error", new Error("spawn gh ENOENT"));
    await rejection;
  });

  it("runs `gh auth token` through runGh with a 10-second timeout", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    respondWith({ stdout: "test-token\n", code: 0 });

    await expect(ghAuthToken()).resolves.toBe("test-token");

    expect(spawnMock).toHaveBeenCalledWith(
      "gh",
      ["auth", "token"],
      expect.objectContaining({ shell: false, stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
  });
});
