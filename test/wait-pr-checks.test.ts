/**
 * Tests for `wait-github-pr-checks`.
 *
 * After `gh pr checks --watch` exits, the tool ignores gh's exit code (gh uses
 * exit 1 for failed checks and exit 8 for pending — neither is a reliable
 * signal) and instead fetches all workflow jobs of the PR's head commit via the
 * Actions API. It reports FAILED with the failed jobs' details when any job did
 * not succeed, PASSED otherwise.
 *
 * Run: npx vitest run test/wait-pr-checks.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import registerTools from "../src/gh-readonly.js";

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

interface ToolDef {
  name: string;
  execute: (
    _id: string,
    params: { number: number | string; repo?: string; fail_fast?: boolean },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: { cwd?: string },
  ) => Promise<{
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
  }>;
}

function getWaitExecutor(): ToolDef["execute"] {
  const tools: unknown[] = [];
  const pi = {
    registerTool: (t: unknown) => {
      tools.push(t);
      return tools.length;
    },
  };
  registerTools(pi as unknown as Parameters<typeof registerTools>[0]);
  const tool = tools.find(
    (t): t is ToolDef => (t as { name?: string }).name === "wait-github-pr-checks",
  );
  if (!tool) throw new Error("wait-github-pr-checks not registered");
  return tool.execute;
}

const exec = getWaitExecutor();
const call = () =>
  exec("id", { number: 1, repo: "owner/repo" }, undefined, undefined, { cwd: undefined });

/** Queue a fake `gh` invocation whose output is resolved on the next tick. */
function queueGh(outputs: { code: number; stdout: string }[]): void {
  let i = 0;
  spawnMock.mockImplementation(() => {
    const fake = new FakeChildProcess();
    const out = outputs[i++];
    setTimeout(() => fake.exit(out.code, out.stdout), 0);
    return fake;
  });
}

afterEach(() => {
  spawnMock.mockClear();
});

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue(new FakeChildProcess());
});

describe("wait-github-pr-checks", () => {
  it("reports PASSED when all jobs succeed, regardless of gh watch exit code", async () => {
    queueGh([
      { code: 0, stdout: "" }, // gh pr checks --watch
      {
        code: 0,
        stdout: JSON.stringify({ headRefOid: "abc123def456" }), // gh pr view
      },
      {
        code: 0,
        stdout: JSON.stringify({
          total_count: 1,
          workflow_runs: [
            { id: 5, name: "CI", html_url: "https://github.com/owner/repo/actions/runs/5" },
          ],
        }), // actions/runs
      },
      {
        code: 0,
        stdout: JSON.stringify({
          total_count: 2,
          jobs: [
            { id: 10, name: "build", status: "completed", conclusion: "success", steps: [] },
            { id: 11, name: "test", status: "completed", conclusion: "success", steps: [] },
          ],
        }), // actions/runs/5/jobs
      },
    ]);

    const result = await call();
    expect(result.content[0].text).toContain("PASSED");
    expect(result.content[0].text).toContain("All 2 job(s) succeeded.");
    expect(result.details).toMatchObject({ status: "success", totalJobs: 2 });
  });

  it("reports FAILED with failed job details when any job fails (gh watch exits 1)", async () => {
    queueGh([
      { code: 1, stdout: "" }, // gh pr checks --watch: exit 1 = SilentError (checks failed)
      {
        code: 0,
        stdout: JSON.stringify({ headRefOid: "abc123def456" }),
      },
      {
        code: 0,
        stdout: JSON.stringify({
          total_count: 1,
          workflow_runs: [
            { id: 5, name: "CI", html_url: "https://github.com/owner/repo/actions/runs/5" },
          ],
        }),
      },
      {
        code: 0,
        stdout: JSON.stringify({
          total_count: 2,
          jobs: [
            {
              id: 10,
              name: "build",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/owner/repo/actions/runs/5/job/10",
              steps: [],
            },
            { id: 11, name: "test", status: "completed", conclusion: "success", steps: [] },
          ],
        }),
      },
    ]);

    const result = await call();
    expect(result.content[0].text).toContain("FAILED");
    expect(result.content[0].text).toContain("1 of 2 job(s) did not succeed");
    expect(result.content[0].text).toContain("**build** (failure)");
    expect(result.content[0].text).toContain("job/10");
    expect(result.details).toMatchObject({ status: "failure", totalJobs: 2 });
    const failedJobs = result.details.failedJobs as { jobName: string; conclusion: string }[];
    expect(failedJobs).toHaveLength(1);
    expect(failedJobs[0]).toMatchObject({ jobName: "build", conclusion: "failure" });
  });

  it("treats a non-success conclusion (cancelled) as not succeeded", async () => {
    queueGh([
      { code: 0, stdout: "" },
      { code: 0, stdout: JSON.stringify({ headRefOid: "abc123def456" }) },
      {
        code: 0,
        stdout: JSON.stringify({
          total_count: 1,
          workflow_runs: [
            { id: 5, name: "CI", html_url: "https://github.com/owner/repo/actions/runs/5" },
          ],
        }),
      },
      {
        code: 0,
        stdout: JSON.stringify({
          total_count: 1,
          jobs: [
            { id: 10, name: "build", status: "completed", conclusion: "cancelled", steps: [] },
          ],
        }),
      },
    ]);

    const result = await call();
    expect(result.content[0].text).toContain("FAILED");
    expect(result.details).toMatchObject({ status: "failure" });
  });

  it("throws when the watch process is killed (timeout/abort)", async () => {
    const ac = new AbortController();
    const promise = exec("id", { number: 1, repo: "owner/repo" }, ac.signal, undefined, {
      cwd: undefined,
    });
    ac.abort();

    await expect(promise).rejects.toThrow(/was aborted/);
  });
});
