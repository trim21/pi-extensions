/**
 * Tests for `wait-github-pr-checks`.
 *
 * The tool polls `gh pr checks --json` each round (streaming a compact bullet
 * list of in-flight checks via onUpdate), then fetches all workflow jobs of
 * the PR's head commit via the Actions API. It reports FAILED with the failed
 * jobs' details when any job did not succeed, PASSED otherwise.
 *
 * In JSON mode gh exits 0 whenever it could fetch the checks — completion is
 * judged from the `bucket` field, not the exit code.
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

import registerTools, { pollPrChecks, renderPrChecksList } from "../src/gh-readonly.js";

interface CheckFixture {
  name: string;
  state: string;
  bucket: string;
  startedAt: string | null;
  completedAt: string | null;
  link: string | null;
  workflow: string | null;
}

function check(overrides: Partial<CheckFixture>): CheckFixture {
  return {
    name: "build",
    state: "SUCCESS",
    bucket: "pass",
    startedAt: "2026-09-05T03:12:01Z",
    completedAt: "2026-09-05T03:15:09Z",
    link: "https://github.com/owner/repo/actions/runs/5/job/10",
    workflow: "CI",
    ...overrides,
  };
}

const checksJson = (checks: CheckFixture[]): string => JSON.stringify(checks);

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
    onUpdate:
      ((msg: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
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

// gh-readonly 在 Windows 上整体禁用（见 gh-readonly.ts），executor 测试只属于
// 非 Windows 平台；guard 避免模块加载时在 win32 上调用扩展工厂。
const exec = process.platform === "win32" ? undefined : getWaitExecutor();
const call = (onUpdate?: ToolDef["execute"] extends (...args: infer A) => unknown ? A[3] : never) =>
  exec!("id", { number: 1, repo: "owner/repo" }, undefined, onUpdate, { cwd: undefined });

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

describe("renderPrChecksList", () => {
  it("lists running checks first, queued after, and hides completed ones", () => {
    const text = renderPrChecksList({
      prNumber: 7,
      round: 2,
      checks: [
        check({}),
        check({
          name: "e2e",
          state: "PENDING",
          bucket: "pending",
          startedAt: "2026-09-05T03:15:30Z",
          completedAt: null,
          link: null,
        }),
        check({
          name: "lint",
          state: "SKIPPING",
          bucket: "skipping",
          startedAt: null,
          completedAt: null,
          link: null,
          workflow: null,
        }),
        check({
          name: "queued",
          state: "QUEUED",
          bucket: "pending",
          startedAt: null,
          completedAt: null,
          link: null,
          workflow: null,
        }),
      ],
    });

    expect(text).toContain("PR #7 checks — round 2: 2/4 complete");
    const lines = text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toEqual(["- [>] e2e", "- [ ] queued"]);
    // completed and skipped checks are hidden
    expect(text).not.toContain("build");
    expect(text).not.toContain("lint");
  });

  it("renders a link for checks that have one and omits the body when all checks are complete", () => {
    const allComplete = renderPrChecksList({ prNumber: 7, round: 2, checks: [check({})] });
    expect(allComplete).toBe("### PR #7 checks — round 2: 1/1 complete");
    expect(allComplete).not.toContain("- [");

    const linked = renderPrChecksList({
      prNumber: 7,
      round: 1,
      checks: [
        check({
          name: "e2e",
          state: "PENDING",
          bucket: "pending",
          startedAt: "2026-09-05T03:15:30Z",
          completedAt: null,
        }),
      ],
    });
    expect(linked).toContain("- [>] [e2e](https://github.com/owner/repo/actions/runs/5/job/10)");
  });

  it("marks an empty check list as no checks reported", () => {
    const text = renderPrChecksList({ prNumber: 7, round: 1, checks: [] });
    expect(text).toContain("PR #7 checks — round 1: 0/0 complete");
    expect(text).toContain("- _no checks reported_");
  });
});

describe.skipIf(process.platform === "win32")("pollPrChecks", () => {
  it("re-polls while checks are pending and emits a list each round", async () => {
    queueGh([
      {
        code: 0,
        stdout: checksJson([check({ bucket: "pending", state: "PENDING", completedAt: null })]),
      },
      { code: 0, stdout: checksJson([check({})]) },
    ]);
    const updates: string[] = [];

    await pollPrChecks({
      prNumber: 1,
      repo: "owner/repo",
      failFast: false,
      intervalMs: 1,
      onUpdate: (msg) => {
        for (const part of msg.content) {
          updates.push(part.text);
        }
      },
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain("round 1");
    expect(updates[0]).toContain(
      "- [>] [build](https://github.com/owner/repo/actions/runs/5/job/10)",
    );
    expect(updates[1]).toContain("round 2");
    expect(updates[1]).toContain("1/1 complete");
    expect(updates[1]).not.toContain("- [");
  });

  it("stops immediately on a fail-fast failure even when checks are pending", async () => {
    queueGh([
      {
        code: 0,
        stdout: checksJson([
          check({ name: "broken", bucket: "fail", state: "FAILURE" }),
          check({ bucket: "pending", state: "PENDING", completedAt: null }),
        ]),
      },
    ]);

    await pollPrChecks({
      prNumber: 1,
      repo: "owner/repo",
      failFast: true,
      intervalMs: 1,
      onUpdate: undefined,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("stops at the deadline even when checks are still pending", async () => {
    queueGh([
      {
        code: 0,
        stdout: checksJson([check({ bucket: "pending", state: "PENDING", completedAt: null })]),
      },
    ]);

    await pollPrChecks({
      prNumber: 1,
      repo: "owner/repo",
      failFast: false,
      intervalMs: 60_000,
      deadlineMs: 0,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("returns without polling again when gh exits non-zero (e.g. no checks reported)", async () => {
    queueGh([{ code: 1, stdout: "" }]);

    await expect(
      pollPrChecks({ prNumber: 1, repo: "owner/repo", failFast: false, intervalMs: 1 }),
    ).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the poll process is killed (abort)", async () => {
    const ac = new AbortController();
    const promise = pollPrChecks({
      prNumber: 1,
      repo: "owner/repo",
      failFast: false,
      signal: ac.signal,
    });
    ac.abort();

    await expect(promise).rejects.toThrow(/was aborted/);
  });
});

describe.skipIf(process.platform === "win32")("wait-github-pr-checks", () => {
  it("reports PASSED when all jobs succeed, regardless of gh checks exit code", async () => {
    queueGh([
      { code: 0, stdout: checksJson([check({}), check({ name: "test" })]) }, // pr checks --json poll
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

  it("reports FAILED with failed job details when any job fails", async () => {
    queueGh([
      { code: 1, stdout: "" }, // pr checks poll errors (e.g. no checks) → fall through to API
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
      { code: 0, stdout: checksJson([check({})]) },
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

  it("streams a checks list via onUpdate before the final report", async () => {
    queueGh([
      {
        code: 0,
        stdout: checksJson([
          check({ name: "unit", bucket: "fail", state: "FAILURE" }),
          check({ name: "build", bucket: "pending", state: "PENDING", completedAt: null }),
        ]),
      },
      { code: 0, stdout: JSON.stringify({ headRefOid: "abc123def456" }) },
      {
        code: 0,
        stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }),
      },
    ]);
    const updates: string[] = [];

    const result = await exec!(
      "id",
      { number: 1, repo: "owner/repo", fail_fast: true },
      undefined,
      (msg: { content: { type: "text"; text: string }[] }) => {
        for (const part of msg.content) updates.push(part.text);
      },
      { cwd: undefined },
    );

    expect(updates.some((t) => t.includes("Watching CI checks for PR #1"))).toBe(true);
    expect(updates.some((t) => t.includes("round 1") && t.includes("- [>] [build]("))).toBe(true);
    expect(result.content[0].text).toContain("No workflow runs found");
  });

  it("throws when the poll process is killed (timeout/abort)", async () => {
    const ac = new AbortController();
    const promise = exec!("id", { number: 1, repo: "owner/repo" }, ac.signal, undefined, {
      cwd: undefined,
    });
    ac.abort();

    await expect(promise).rejects.toThrow(/was aborted/);
  });
});
