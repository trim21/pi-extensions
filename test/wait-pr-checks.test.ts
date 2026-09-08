/**
 * Unit tests for the wait-github-pr-checks pipeline layers after the API:
 *
 * - mergeChecks: commit statuses + check runs -> merged, judged checks
 * - pollPrChecks: the wait loop (any fail / all pass|skipped / timeout)
 * - renderPrChecksList: per-round in-flight rendering
 * - renderChecksVerdict: final PASSED / FAILED / STILL IN FLIGHT reports
 *
 * The API client itself (octokit-backed, lib/github.js) is a thin adapter and
 * is not mocked or tested here.
 *
 * Run: pnpm exec vitest run test/wait-pr-checks.test.ts
 */
import { describe, expect, it, vi } from "vitest";

import {
  type ChecksPollResult,
  mergeChecks,
  type MergedCheck,
  pollPrChecks,
  renderChecksVerdict,
  renderPrChecksList,
} from "../src/gh-readonly.js";
import type { ActionJob, CheckRun, CommitStatus } from "../src/lib/github.js";

function status(overrides: Partial<CommitStatus> & { context?: string }): CommitStatus {
  return {
    context: "linux_64_",
    state: "success",
    targetUrl: "https://dev.azure.com/conda-forge/staged-recipes/_build/results?buildId=1",
    ...overrides,
  };
}

function run(overrides: Partial<CheckRun> & { name?: string }): CheckRun {
  return {
    name: "build",
    status: "completed",
    conclusion: "success",
    startedAt: "2026-09-05T03:12:01Z",
    url: "https://github.com/owner/repo/actions/runs/5/job/10",
    event: null,
    ...overrides,
  };
}

function merged(overrides: Partial<MergedCheck> & { name?: string }): MergedCheck {
  return {
    name: "build",
    bucket: "pass",
    startedAt: "2026-09-05T03:12:01Z",
    link: "https://github.com/owner/repo/actions/runs/5/job/10",
    event: null,
    ...overrides,
  };
}

function job(overrides: Partial<ActionJob> & { jobId?: number }): ActionJob {
  return {
    runId: 5,
    runName: "CI",
    runUrl: "https://github.com/owner/repo/actions/runs/5",
    jobId: overrides.jobId ?? 10,
    jobName: "build",
    conclusion: "success",
    jobUrl: "https://github.com/owner/repo/actions/runs/5/job/10",
    ...overrides,
  };
}

const HEAD_OID = "abc123def4567890";

/** A GithubChecksClient whose responses are scripted per test. */
function fakeClient(
  overrides: {
    statuses?: (round: number) => Promise<readonly CommitStatus[]>;
    checkRuns?: (round: number) => Promise<readonly CheckRun[]>;
  } = {},
): {
  statuses: ReturnType<typeof vi.fn>;
  checkRuns: ReturnType<typeof vi.fn>;
  actionJobs: ReturnType<typeof vi.fn>;
} {
  return {
    statuses: vi.fn(overrides.statuses ?? (() => Promise.resolve([]))),
    checkRuns: vi.fn(overrides.checkRuns ?? (() => Promise.resolve([]))),
    actionJobs: vi.fn(() => Promise.resolve([])),
  };
}

describe("mergeChecks", () => {
  it("maps commit status states to buckets", () => {
    const checks = mergeChecks(
      [
        status({ context: "a", state: "success" }),
        status({ context: "b", state: "failure" }),
        status({ context: "c", state: "error" }),
        status({ context: "d", state: "pending" }),
        status({ context: "e", state: "expected" }),
        status({ context: "f", state: "something-new" }),
      ],
      [],
    );

    expect(Object.fromEntries(checks.map((c) => [c.name, c.bucket]))).toEqual({
      a: "pass",
      b: "fail",
      c: "fail",
      d: "pending",
      e: "pending",
      f: "pending",
    });
  });

  it("maps check run conclusions to buckets", () => {
    const checks = mergeChecks(
      [],
      [
        run({ name: "a", status: "in_progress", conclusion: null }),
        run({ name: "b", status: "queued", conclusion: null }),
        run({ name: "c", conclusion: "success" }),
        run({ name: "d", conclusion: "skipped" }),
        run({ name: "e", conclusion: "neutral" }),
        run({ name: "f", conclusion: "stale" }),
        run({ name: "g", conclusion: "failure" }),
        run({ name: "h", conclusion: "timed_out" }),
        run({ name: "i", conclusion: "cancelled" }),
        run({ name: "j", conclusion: "startup_failure" }),
        run({ name: "k", conclusion: "action_required" }),
        run({ name: "l", conclusion: "brand-new" }),
      ],
    );

    expect(Object.fromEntries(checks.map((c) => [c.name, c.bucket]))).toEqual({
      a: "pending",
      b: "pending",
      c: "pass",
      d: "skipped",
      e: "skipped",
      f: "skipped",
      g: "fail",
      h: "fail",
      i: "fail",
      j: "fail",
      // awaiting approval never runs, so it must not block the wait
      k: "skipped",
      l: "pending",
    });
  });

  it("keeps same-named check runs (push + pull_request double trigger) as distinct checks", () => {
    const checks = mergeChecks(
      [],
      [
        run({ name: "build", event: "push", conclusion: "success" }),
        run({ name: "build", event: "pull_request", conclusion: "failure" }),
        run({ name: "test", conclusion: "success" }),
        run({ name: "test", status: "in_progress", conclusion: null }),
      ],
    );

    expect(checks.map((c) => [c.event, c.bucket])).toEqual([
      ["push", "pass"],
      ["pull_request", "fail"],
      [null, "pass"],
      [null, "pending"],
    ]);
  });

  it("keeps a status and a check run reported under one name as distinct checks", () => {
    const checks = mergeChecks(
      [status({ context: "ci", state: "success" })],
      [run({ name: "ci", status: "in_progress", conclusion: null })],
    );

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: "ci", bucket: "pass", event: null });
    expect(checks[1]).toMatchObject({
      name: "ci",
      bucket: "pending",
      event: null,
      startedAt: "2026-09-05T03:12:01Z",
    });
  });
});

describe("renderPrChecksList", () => {
  it("lists running checks first, queued after, and hides completed ones", () => {
    const text = renderPrChecksList({
      prNumber: 7,
      round: 2,
      checks: [
        merged({}),
        merged({ name: "e2e", bucket: "pending", startedAt: "2026-09-05T03:15:30Z", link: null }),
        merged({ name: "lint", bucket: "skipped", startedAt: null, link: null }),
        merged({ name: "queued", bucket: "pending", startedAt: null, link: null }),
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
    const allComplete = renderPrChecksList({ prNumber: 7, round: 2, checks: [merged({})] });
    expect(allComplete).toBe("PR #7 checks — round 2: 1/1 complete");
    expect(allComplete).not.toContain("- [");

    const linked = renderPrChecksList({
      prNumber: 7,
      round: 1,
      checks: [merged({ name: "e2e", bucket: "pending", startedAt: "2026-09-05T03:15:30Z" })],
    });
    expect(linked).toContain("- [>] [e2e](https://github.com/owner/repo/actions/runs/5/job/10)");
  });

  it("labels checks with their distinct trigger events like the GitHub UI", () => {
    const text = renderPrChecksList({
      prNumber: 7,
      round: 1,
      checks: [
        merged({
          name: "build",
          bucket: "pending",
          startedAt: "2026-09-05T03:15:30Z",
          link: null,
          event: "pull_request",
        }),
        merged({
          name: "build",
          bucket: "pending",
          startedAt: null,
          link: null,
          event: "push",
        }),
        merged({ name: "e2e", bucket: "pending", startedAt: null, link: null }),
      ],
    });

    const lines = text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toEqual(["- [>] build (pull_request)", "- [ ] build (push)", "- [ ] e2e"]);
  });

  it("marks an empty check list as no checks reported", () => {
    const text = renderPrChecksList({ prNumber: 7, round: 1, checks: [] });
    expect(text).toContain("PR #7 checks — round 1: 0/0 complete");
    expect(text).toContain("- _no checks reported_");
  });
});

function pollOptions(
  client: ReturnType<typeof fakeClient>,
  overrides: Partial<Parameters<typeof pollPrChecks>[0]> = {},
): Parameters<typeof pollPrChecks>[0] {
  return {
    prNumber: 1,
    owner: "owner",
    repo: "repo",
    headSha: HEAD_OID,
    failFast: false,
    checks: client as unknown as Parameters<typeof pollPrChecks>[0]["checks"],
    signal: new AbortController().signal,
    intervalMs: 1,
    ...overrides,
  };
}

describe("pollPrChecks", () => {
  it("re-polls while checks are pending and emits a list each round", async () => {
    let round = 0;
    const client = fakeClient({
      statuses: () => Promise.resolve(round === 0 ? [] : [status({})]),
      checkRuns: () =>
        Promise.resolve(
          round++ === 0 ? [run({ status: "in_progress", conclusion: null })] : [run({})],
        ),
    });
    const updates: string[] = [];

    const result = await pollPrChecks({
      ...pollOptions(client),
      onUpdate: (msg) => {
        for (const part of msg.content) {
          updates.push(part.text);
        }
      },
    });

    expect(client.checkRuns).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain("round 1");
    expect(updates[0]).toContain(
      "- [>] [build](https://github.com/owner/repo/actions/runs/5/job/10)",
    );
    expect(updates[1]).toContain("round 2");
    expect(updates[1]).toContain("2/2 complete");
    expect(result).toMatchObject({
      outcome: "completed",
      checks: [
        { name: "linux_64_", bucket: "pass" },
        { name: "build", bucket: "pass" },
      ],
    });
  });

  it("returns fail_fast immediately when a check fails even while others are pending", async () => {
    const client = fakeClient({
      checkRuns: () =>
        Promise.resolve([
          run({ name: "broken", conclusion: "failure" }),
          run({ status: "in_progress", conclusion: null }),
        ]),
    });

    const result = await pollPrChecks({ ...pollOptions(client), failFast: true });

    expect(client.checkRuns).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("fail_fast");
    expect(result.checks).toHaveLength(2);
  });

  it("completes when every check is pass or skipped", async () => {
    const client = fakeClient({
      statuses: () =>
        Promise.resolve([status({}), status({ context: "win_64_", state: "success" })]),
      checkRuns: () => Promise.resolve([run({ name: "linter", conclusion: "skipped" })]),
    });

    const result = await pollPrChecks(pollOptions(client));

    expect(result.outcome).toBe("completed");
    expect(result.checks).toHaveLength(3);
  });

  it("reports timeout with the last snapshot when checks stay pending", async () => {
    const client = fakeClient({
      statuses: () => Promise.resolve([status({ context: "osx_64_", state: "pending" })]),
    });

    const result = await pollPrChecks({ ...pollOptions(client), deadlineMs: 0 });

    expect(result.outcome).toBe("timeout");
    expect(result.checks).toEqual([
      {
        name: "osx_64_",
        bucket: "pending",
        startedAt: null,
        link: expect.any(String),
        event: null,
      },
    ]);
  });

  it("keeps polling through a failed round and succeeds afterwards", async () => {
    let round = 0;
    const client = fakeClient({
      statuses: () =>
        Promise.resolve(round++ === 0 ? Promise.reject(new Error("network blip")) : []),
      checkRuns: () => Promise.resolve([run({})]),
    });

    const result = await pollPrChecks({ ...pollOptions(client), deadlineMs: 5_000 });

    expect(result.outcome).toBe("completed");
    expect(client.checkRuns).toHaveBeenCalledTimes(2);
  });

  it("throws when no round ever succeeded by the deadline", async () => {
    const client = fakeClient({
      statuses: () => Promise.reject(new Error("Bad credentials")),
      checkRuns: () => Promise.reject(new Error("Bad credentials")),
    });

    await expect(pollPrChecks({ ...pollOptions(client), deadlineMs: 0 })).rejects.toThrow(
      /failed before any round succeeded.*Bad credentials/s,
    );
  });

  it("throws when aborted while sleeping between rounds", async () => {
    const client = fakeClient({
      statuses: () => Promise.resolve([status({ context: "osx_64_", state: "pending" })]),
    });
    const ac = new AbortController();
    const promise = pollPrChecks({ ...pollOptions(client), intervalMs: 60_000, signal: ac.signal });
    // let round 1 settle and the loop enter the inter-round sleep
    await new Promise((resolve) => setTimeout(resolve, 0));
    ac.abort();

    await expect(promise).rejects.toThrow(/aborted/);
  });

  it("throws when aborted before the first round", async () => {
    const client = fakeClient();
    const ac = new AbortController();
    ac.abort();

    await expect(pollPrChecks({ ...pollOptions(client), signal: ac.signal })).rejects.toThrow(
      /aborted/,
    );
  });
});

const poll = (overrides: Partial<ChecksPollResult>): ChecksPollResult => ({
  outcome: "completed",
  checks: [],
  elapsedMs: 0,
  ...overrides,
});

describe("renderChecksVerdict", () => {
  it("reports PASSED when every check completed without failures", () => {
    const verdict = renderChecksVerdict({
      prNumber: 1,
      poll: poll({
        checks: [merged({}), merged({ name: "lint", bucket: "skipped", link: null })],
      }),
    });

    expect(verdict).toMatchObject({ status: "success", failedJobs: [] });
    expect(verdict.text).toContain("PASSED");
    expect(verdict.text).toContain("All 2 check(s) passed.");
  });

  it("reports FAILED from the checks buckets, enriched with failed Actions jobs", () => {
    const verdict = renderChecksVerdict({
      prNumber: 1,
      poll: poll({
        outcome: "fail_fast",
        checks: [
          merged({ name: "build", bucket: "fail", event: "pull_request" }),
          merged({ name: "linux_64_", bucket: "fail", link: null, startedAt: null }),
          merged({ name: "osx_64_", bucket: "pending", startedAt: null, link: null }),
        ],
      }),
      actionJobs: [
        job({ conclusion: "failure" }),
        job({ jobId: 11, jobName: "test", conclusion: "success" }),
      ],
    });

    expect(verdict.status).toBe("failure");
    expect(verdict.text).toContain("FAILED");
    expect(verdict.text).toContain("2 of 3 check(s) failed");
    expect(verdict.text).toContain("**build**");
    expect(verdict.text).toContain("**linux_64_**");
    expect(verdict.text).toContain("job **build** (failure)");
    expect(verdict.text).toContain("1 other check(s) still in flight");
    // successful Actions jobs are not listed
    expect(verdict.text).not.toContain("job **test**");
    // event label suffixes appear on failed check names
    expect(verdict.text).toContain("**build (pull_request)**");
    expect(verdict.failedJobs).toEqual([
      {
        runId: 5,
        runName: "CI",
        runUrl: "https://github.com/owner/repo/actions/runs/5",
        jobId: 10,
        jobName: "build",
        conclusion: "failure",
        jobUrl: "https://github.com/owner/repo/actions/runs/5/job/10",
      },
    ]);
  });

  it("treats a missing Actions job conclusion (in progress) as not succeeded", () => {
    const verdict = renderChecksVerdict({
      prNumber: 1,
      poll: poll({
        outcome: "fail_fast",
        checks: [merged({ name: "build", bucket: "fail" })],
      }),
      actionJobs: [job({ jobId: 12, jobName: "deploy", conclusion: null, jobUrl: undefined })],
    });

    expect(verdict.failedJobs[0]).toMatchObject({ jobName: "deploy", conclusion: "in_progress" });
    expect(verdict.text).toContain("job **deploy** (in_progress)");
    // falls back to the run URL when the job has no direct link
    expect(verdict.text).toContain("job #12](https://github.com/owner/repo/actions/runs/5)");
  });

  it("keeps the FAILED verdict when the Actions job enrichment fails", () => {
    const verdict = renderChecksVerdict({
      prNumber: 1,
      poll: poll({
        outcome: "fail_fast",
        checks: [merged({ name: "build", bucket: "fail" })],
      }),
      enrichmentError: "rate limited",
    });

    expect(verdict.status).toBe("failure");
    expect(verdict.text).toContain("FAILED");
    expect(verdict.text).toContain("Actions job details unavailable: rate limited");
  });

  it("reports the in-flight snapshot as pending on timeout instead of a verdict", () => {
    const verdict = renderChecksVerdict({
      prNumber: 1,
      poll: poll({
        outcome: "timeout",
        elapsedMs: 600_000,
        checks: [
          merged({ name: "osx_64_", bucket: "pending", startedAt: null, link: null }),
          merged({ name: "build" }),
        ],
      }),
    });

    expect(verdict.status).toBe("pending");
    expect(verdict.failedJobs).toEqual([]);
    expect(verdict.text).toContain("STILL IN FLIGHT");
    expect(verdict.text).toContain("1 of 2 check(s) still incomplete after ~10m");
    expect(verdict.text).toContain("- [ ] osx_64_");
    expect(verdict.text).not.toContain("PASSED");
  });

  it("marks a timeout with no checks ever reported", () => {
    const verdict = renderChecksVerdict({
      prNumber: 1,
      poll: poll({ outcome: "timeout", elapsedMs: 600_000 }),
    });

    expect(verdict.status).toBe("pending");
    expect(verdict.text).toContain("- _no checks reported_");
  });
});
