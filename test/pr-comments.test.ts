/**
 * Regression tests for `read-github-pr-comments` with `reviews=true`: the two
 * REST list endpoints it reads page at 30 items by default, so they must be
 * requested with `--paginate --slurp` and the page arrays flattened — a single
 * page silently dropped every review comment past the first 30.
 *
 * Run: npx vitest run test/pr-comments.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import registerTools from "../src/gh-readonly.js";

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    return true;
  }

  exit(code: number, stdout = ""): void {
    if (stdout) this.stdout.write(stdout);
    this.emit("close", code);
  }
}

interface ToolDef {
  name: string;
  execute: (
    _id: string,
    params: { number: number | string; repo?: string; reviews?: boolean },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: { cwd?: string },
  ) => Promise<{ content: { type: "text"; text: string }[] }>;
}

function getExecutor(): ToolDef["execute"] {
  const tools: unknown[] = [];
  const pi = {
    on: () => {},
    registerTool: (t: unknown) => {
      tools.push(t);
      return tools.length;
    },
  };
  registerTools(pi as unknown as Parameters<typeof registerTools>[0]);
  const tool = tools.find(
    (t): t is ToolDef => (t as { name?: string }).name === "read-github-pr-comments",
  );
  if (!tool) throw new Error("read-github-pr-comments not registered");
  return tool.execute;
}

const exec = process.platform === "win32" ? undefined : getExecutor();

afterEach(() => {
  spawnMock.mockReset();
});

describe.skipIf(process.platform === "win32")("read-github-pr-comments (reviews=true)", () => {
  it("pages both list endpoints and flattens their pages", async () => {
    const procs: FakeChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const proc = new FakeChildProcess();
      procs.push(proc);
      return proc;
    });

    const promise = exec!("id", { number: 7, repo: "o/r", reviews: true }, undefined, undefined, {
      cwd: undefined,
    });
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    const argvOf = (call: number): string[] => spawnMock.mock.calls[call]?.[1] as string[];
    const commentsArgs = argvOf(0);
    const reviewsArgs = argvOf(1);
    expect(commentsArgs).toEqual(["api", "--paginate", "--slurp", "/repos/o/r/pulls/7/comments"]);
    expect(reviewsArgs).toEqual(["api", "--paginate", "--slurp", "/repos/o/r/pulls/7/reviews"]);

    // `--slurp` wraps the pages, so the output is an array of page arrays
    procs[0].exit(0, JSON.stringify([[{ id: 1 }], [{ id: 31 }]]));
    procs[1].exit(0, JSON.stringify([[{ id: 2, state: "APPROVED" }]]));

    const result = await promise;
    expect(JSON.parse(result.content[0].text)).toEqual({
      reviews: [{ id: 2, state: "APPROVED" }],
      comments: [{ id: 1 }, { id: 31 }],
    });
  });
});
