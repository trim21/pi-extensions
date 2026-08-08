/**
 * Tests for `read-github-pr-status` — it must return the current snapshot of
 * `gh pr checks` immediately, without polling.
 *
 * `gh pr checks` exit codes: 0 = all passed, 1 = some failed, 8 = some pending.
 * All three are valid states; pending must be reported as-is (regression: it
 * used to poll until the checks resolved, duplicating `wait-github-pr-checks`).
 * Any other exit code is a real error and throws a GhError.
 *
 * Run: npx vitest run test/pr-status.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import registerTools from "../src/gh-readonly.js";
import { GhError } from "../src/gh-readonly.js";

/** A fake gh child process that exits with the given code when told. */
class FakeChildProcess extends EventEmitter {
  killed = false;
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
}

let fakeProc: FakeChildProcess;

interface ToolDef {
  name: string;
  execute: (
    _id: string,
    params: { number: number | string; repo?: string },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: { cwd?: string },
  ) => Promise<{
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
  }>;
}

function getPrStatusExecutor(): ToolDef["execute"] {
  const tools: unknown[] = [];
  const pi = {
    registerTool: (t: unknown) => {
      tools.push(t);
      return tools.length;
    },
  };
  registerTools(pi as Parameters<typeof registerTools>[0]);
  const tool = tools.find(
    (t): t is ToolDef => (t as { name?: string }).name === "read-github-pr-status",
  );
  if (!tool) throw new Error("read-github-pr-status not registered");
  return tool.execute;
}

const exec = getPrStatusExecutor();
const call = () => exec("id", { number: 1 }, undefined, undefined, { cwd: undefined });

beforeEach(() => {
  fakeProc = new FakeChildProcess();
  spawnMock.mockReturnValue(fakeProc);
});

afterEach(() => {
  spawnMock.mockClear();
});

describe("read-github-pr-status", () => {
  it("returns the current checks immediately when all checks pass (exit 0)", async () => {
    const promise = call();
    fakeProc.exit(0, "passed table");

    const result = await promise;
    expect(result.content[0].text).toBe("passed table");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("returns the current checks immediately when a check fails (exit 1)", async () => {
    const promise = call();
    fakeProc.exit(1, "failed table");

    const result = await promise;
    expect(result.content[0].text).toBe("failed table");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("returns pending checks as-is without polling (exit 8)", async () => {
    const promise = call();
    fakeProc.exit(8, "pending table");

    const result = await promise;
    expect(result.content[0].text).toBe("pending table");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("throws GhError for any other exit code", async () => {
    const promise = call();
    fakeProc.exit(2);

    await expect(promise).rejects.toThrow(GhError);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
