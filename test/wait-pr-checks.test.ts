/**
 * Unit tests for the wait-github-pr-checks pipeline layers after the API:
 *
 * - mergeChecks: commit statuses + check runs -> merged, judged checks
 * - pollPrChecks: the wait loop (any fail / all pass|skipped / timeout)
 * - checksVerdict: the final success / failure / pending / awaiting_approval verdict
 *
 * The API client itself (octokit-backed, lib/github.js) is a thin adapter and
 * is not mocked or tested here.
 *
 * Run: pnpm exec vitest run test/wait-pr-checks.test.ts
 */
import { describe, expect, it, vi } from "vitest";

import {
  type ChecksPollResult,
  checksVerdict,
  mergeChecks,
  type MergedCheck,
  pollPrChecks,
} from "../src/gh/index.js";
import type {
  ActionJob,
  CheckRun,
  CheckSuite,
  CommitStatus,
  WorkflowRunRef,
} from "../src/lib/github.js";

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
    checkSuiteId: null,
    runId: 5,
    jobId: 10,
    ...overrides,
  };
}

function suite(overrides: Partial<CheckSuite> & { id?: number }): CheckSuite {
  return {
    id: 100,
    appSlug: "github-actions",
    status: "completed",
    conclusion: "action_required",
    ...overrides,
  };
}

function workflowRun(overrides: Partial<WorkflowRunRef> & { id?: number }): WorkflowRunRef {
  return {
    id: 5,
    checkSuiteId: 100,
    name: "CI",
    event: "pull_request",
    htmlUrl: "https://github.com/owner/repo/actions/runs/5",
    runStartedAt: "2026-09-05T03:12:00Z",
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
    suiteId: null,
    runId: 5,
    jobId: 10,
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
    suites?: (round: number) => Promise<readonly CheckSuite[]>;
    workflowRuns?: (round: number) => Promise<readonly WorkflowRunRef[]>;
  } = {},
): {
  statuses: ReturnType<typeof vi.fn>;
  checkRuns: ReturnType<typeof vi.fn>;
  suites: ReturnType<typeof vi.fn>;
  workflowRuns: ReturnType<typeof vi.fn>;
  actionJobs: ReturnType<typeof vi.fn>;
} {
  return {
    statuses: vi.fn(overrides.statuses ?? (() => Promise.resolve([]))),
    checkRuns: vi.fn(overrides.checkRuns ?? (() => Promise.resolve([]))),
    suites: vi.fn(overrides.suites ?? (() => Promise.resolve([]))),
    workflowRuns: vi.fn(overrides.workflowRuns ?? (() => Promise.resolve([]))),
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
      [],
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
      [],
      [],
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
      // awaiting approval cannot start on its own: it must not be judged passed
      k: "action_required",
      l: "pending",
    });
  });

  it("keeps same-named check runs (push + pull_request double trigger) as distinct checks", () => {
    const checks = mergeChecks(
      [],
      [
        run({ name: "build", runId: 5, conclusion: "success" }),
        run({ name: "build", runId: 6, conclusion: "failure" }),
        run({ name: "test", runId: null, conclusion: "success" }),
        run({ name: "test", runId: null, status: "in_progress", conclusion: null }),
      ],
      [],
      [workflowRun({ id: 5, event: "push" }), workflowRun({ id: 6, event: "pull_request" })],
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
      [],
      [],
    );

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: "ci", bucket: "pass", event: null, suiteId: null });
    expect(checks[1]).toMatchObject({
      name: "ci",
      bucket: "pending",
      event: null,
      startedAt: "2026-09-05T03:12:01Z",
    });
  });

  it("expands a suite with no check runs into its own check, named by its workflow run", () => {
    const checks = mergeChecks(
      [],
      [],
      [suite({ id: 100, conclusion: "action_required" })],
      [
        workflowRun({
          id: 42,
          checkSuiteId: 100,
          name: "FreeBSD",
          event: "pull_request",
          htmlUrl: "https://github.com/owner/repo/actions/runs/42",
        }),
      ],
    );

    expect(checks).toEqual([
      {
        name: "FreeBSD",
        bucket: "action_required",
        startedAt: "2026-09-05T03:12:00Z",
        link: "https://github.com/owner/repo/actions/runs/42",
        event: "pull_request",
        suiteId: 100,
        runId: 42,
        jobId: null,
      },
    ]);
  });

  it("falls back to the app slug for a suite with no workflow run (non-Actions app)", () => {
    const checks = mergeChecks([], [], [suite({ id: 7, appSlug: "some-app" })], []);

    expect(checks).toMatchObject([
      { name: "some-app", event: null, link: null, suiteId: 7, runId: null },
    ]);
  });

  it("maps suite conclusions to buckets", () => {
    const checks = mergeChecks(
      [],
      [],
      [
        suite({ id: 1, status: "queued", conclusion: null }),
        suite({ id: 2, conclusion: "success" }),
        suite({ id: 3, conclusion: "skipped" }),
        suite({ id: 4, conclusion: "timed_out" }),
        suite({ id: 5, conclusion: "brand-new" }),
        suite({ id: 6, conclusion: "action_required" }),
      ],
      [],
    );

    // the queued shell is skipped; every finished suite is judged
    expect(checks.map((c) => [c.suiteId, c.bucket])).toEqual([
      [2, "pass"],
      [3, "skipped"],
      [4, "fail"],
      [5, "pending"],
      [6, "action_required"],
    ]);
  });

  it("ignores unfinished suites with no check runs (per-app shells)", () => {
    const checks = mergeChecks(
      [],
      [],
      [
        // GitHub creates one per app per commit; apps that never report leave
        // them queued forever, so treating them as pending would hang the wait
        suite({ id: 1, appSlug: "netlify", status: "queued", conclusion: null }),
        suite({ id: 2, appSlug: "vercel", status: "in_progress", conclusion: null }),
      ],
      [],
    );

    expect(checks).toEqual([]);
  });

  it("does not double-count a suite that has check runs of its own", () => {
    const checks = mergeChecks(
      [],
      [run({ name: "job-a", checkSuiteId: 100 }), run({ name: "job-b", checkSuiteId: 100 })],
      [suite({ id: 100, conclusion: "success" })],
      [],
    );

    expect(checks.map((c) => [c.name, c.suiteId])).toEqual([
      ["job-a", 100],
      ["job-b", 100],
    ]);
  });
});

function pollOptions(client: ReturnType<typeof fakeClient>): Parameters<typeof pollPrChecks>[0] {
  return {
    owner: "owner",
    repo: "repo",
    headSha: HEAD_OID,
    failFast: false,
    checks: client as unknown as Parameters<typeof pollPrChecks>[0]["checks"],
    signal: new AbortController().signal,
    intervalMs: 1,
  };
}

describe("pollPrChecks", () => {
  it("re-polls while checks are pending until they complete", async () => {
    let round = 0;
    const client = fakeClient({
      statuses: () => Promise.resolve(round === 0 ? [] : [status({})]),
      checkRuns: () =>
        Promise.resolve(
          round++ === 0 ? [run({ status: "in_progress", conclusion: null })] : [run({})],
        ),
    });

    const result = await pollPrChecks(pollOptions(client));

    expect(client.checkRuns).toHaveBeenCalledTimes(2);
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

  it("judges only check runs matching the event filter, excluding statuses", async () => {
    const client = fakeClient({
      statuses: () => Promise.resolve([status({ context: "linux_64_", state: "pending" })]),
      checkRuns: () =>
        Promise.resolve([
          run({ name: "build", runId: 5, conclusion: "failure" }),
          run({ name: "build", runId: 6, status: "in_progress", conclusion: null }),
        ]),
      workflowRuns: () =>
        Promise.resolve([
          workflowRun({ id: 5, event: "push" }),
          workflowRun({ id: 6, event: "pull_request" }),
        ]),
    });

    const result = await pollPrChecks({ ...pollOptions(client), event: "push" });

    // the pull_request run and the status are out of scope: the filtered set
    // has no pending checks, so the push failure alone completes the wait
    expect(result.outcome).toBe("completed");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "build", event: "push", bucket: "fail" });
  });

  it("returns awaiting_approval after one round when a workflow waits for approval", async () => {
    const client = fakeClient({
      suites: () => Promise.resolve([suite({ id: 100, conclusion: "action_required" })]),
      workflowRuns: () => Promise.resolve([workflowRun({ id: 42, checkSuiteId: 100, name: "CI" })]),
    });

    const result = await pollPrChecks({ ...pollOptions(client), intervalMs: 1 });

    // approval will not arrive on its own, so the wait must not burn the deadline
    expect(client.suites).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("awaiting_approval");
    expect(result.checks).toMatchObject([
      { name: "CI", bucket: "action_required", suiteId: 100, runId: 42 },
    ]);
  });

  it("lets a failure win over a workflow waiting for approval", async () => {
    const client = fakeClient({
      checkRuns: () => Promise.resolve([run({ name: "broken", conclusion: "failure" })]),
      suites: () => Promise.resolve([suite({ id: 100 })]),
    });

    const result = await pollPrChecks({ ...pollOptions(client), failFast: true });

    expect(result.outcome).toBe("fail_fast");
    expect(result.checks.map((c) => c.bucket)).toEqual(["fail", "action_required"]);
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
        suiteId: null,
        runId: null,
        jobId: null,
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

describe("checksVerdict", () => {
  it("reports success when every check completed without failures", () => {
    const verdict = checksVerdict({
      poll: poll({
        checks: [merged({}), merged({ name: "lint", bucket: "skipped", link: null })],
      }),
    });

    expect(verdict).toEqual({ status: "success", failedJobs: [] });
  });

  it("reports failure from the checks buckets, enriched with failed Actions jobs", () => {
    const verdict = checksVerdict({
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
    // 成功的 Actions job 不进 failedJobs
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
    const verdict = checksVerdict({
      poll: poll({ outcome: "fail_fast", checks: [merged({ name: "build", bucket: "fail" })] }),
      actionJobs: [job({ jobId: 12, jobName: "deploy", conclusion: null, jobUrl: undefined })],
    });

    expect(verdict.failedJobs[0]).toMatchObject({ jobName: "deploy", conclusion: "in_progress" });
  });

  it("keeps the failure verdict when the Actions job enrichment is missing", () => {
    const verdict = checksVerdict({
      poll: poll({ outcome: "fail_fast", checks: [merged({ name: "build", bucket: "fail" })] }),
    });

    expect(verdict).toEqual({ status: "failure", failedJobs: [] });
  });

  it("reports awaiting_approval instead of success", () => {
    const verdict = checksVerdict({
      poll: poll({
        outcome: "awaiting_approval",
        checks: [
          merged({ name: "DCO", bucket: "pass" }),
          merged({
            name: "CI",
            bucket: "action_required",
            event: "pull_request",
            startedAt: null,
            link: "https://github.com/owner/repo/actions/runs/42",
          }),
        ],
      }),
    });

    expect(verdict).toEqual({ status: "awaiting_approval", failedJobs: [] });
  });

  it("reports failure when a failure and an approval wait arrive together", () => {
    const verdict = checksVerdict({
      poll: poll({
        outcome: "awaiting_approval",
        checks: [
          merged({ name: "build", bucket: "fail" }),
          merged({ name: "CI", bucket: "action_required", startedAt: null, link: null }),
        ],
      }),
    });

    expect(verdict.status).toBe("failure");
  });

  it("reports the in-flight snapshot as pending on timeout", () => {
    const verdict = checksVerdict({
      poll: poll({
        outcome: "timeout",
        elapsedMs: 600_000,
        checks: [
          merged({ name: "osx_64_", bucket: "pending", startedAt: null, link: null }),
          merged({ name: "build" }),
        ],
      }),
    });

    expect(verdict).toEqual({ status: "pending", failedJobs: [] });
  });

  it("marks a timeout with no checks ever reported as pending", () => {
    const verdict = checksVerdict({ poll: poll({ outcome: "timeout", elapsedMs: 600_000 }) });

    expect(verdict).toEqual({ status: "pending", failedJobs: [] });
  });
});
