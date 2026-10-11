/**
 * Tests for `read-github-pr-status` (the handler in `src/gh/tools/read-pr-status.ts`) —
 * it must return the
 * current checks of the PR's head commit immediately, without polling, and each
 * Actions-backed check has to carry the `run_id` / `job_id` that lead to its log.
 *
 * Responses come from recorded fixtures (see test/github-fixtures.ts), injected
 * into the client: these tests never touch the network nor `globalThis.fetch`.
 * The auth token is injected too, so no `gh` process is spawned either.
 *
 * Run: npx vitest run test/pr-status.test.ts
 * Re-record: RECORD_GITHUB=1 pnpm exec vitest run --testTimeout=60000 test/pr-status.test.ts
 */
import { describe, expect, it } from "vitest";

import { GhClient, prStatus } from "../src/gh/index.js";
import { type FixtureRoutes, type GithubCassette, githubCassette } from "./github-fixtures.js";

const PULL_ROUTE = "pulls/137";
const STATUS_ROUTE = "commits/";
const RUNS_ROUTE = "actions/runs?head_sha=";

interface PullFixture {
  number: number;
  title: string;
  head: { sha: string };
}
interface CombinedStatusFixture {
  total_count: number;
  statuses: { context: string; state: string; target_url: string }[];
}
interface CheckRunsFixture {
  total_count: number;
  check_runs: {
    name: string;
    conclusion: string | null;
    html_url: string;
    details_url: string;
    check_suite: { id: number };
  }[];
}
interface CheckSuitesFixture {
  total_count: number;
  check_suites: { id: number; conclusion: string | null; app: { slug: string } }[];
}
interface WorkflowRunsFixture {
  total_count: number;
  workflow_runs: {
    id: number;
    name: string;
    event: string;
    check_suite_id: number;
    html_url: string;
  }[];
}

const PR_NUMBER = 137;

/** 录制来源：valkey-io/libvalkey-py#89，一个 fork PR，6 个 workflow 在等维护者批准。 */
const FORK_REPO = "valkey-io/libvalkey-py";
const FORK_PR_NUMBER = 89;

/** Route table shared by the tests in this file. */
function routes(): FixtureRoutes {
  return {
    [PULL_ROUTE]: "pull.json",
    // suite and check-run endpoints both live under /commits/<sha>/check-*, so
    // they must precede the combined-status route
    "check-suites": "check-suites.json",
    "check-runs": "check-runs.json",
    [STATUS_ROUTE]: "combined-status.json",
    [RUNS_ROUTE]: "workflow-runs.json",
  };
}

/**
 * Route table of the fork PR awaiting approval: its suites have no check runs,
 * so the suite list is the only place that state shows up.
 */
function forkRoutes(): FixtureRoutes {
  return {
    "pulls/89": "awaiting-approval-pull.json",
    // both suite and check-run endpoints live under /commits/<sha>/check-*, so
    // they must precede the combined-status route
    "check-suites": "awaiting-approval-check-suites.json",
    "check-runs": "awaiting-approval-check-runs.json",
    [RUNS_ROUTE]: "awaiting-approval-workflow-runs.json",
    [STATUS_ROUTE]: "awaiting-approval-combined-status.json",
  };
}

/** Run one toolcall through a client wired to the recorded responses; returns the payload. */
async function callPrStatus(
  api: GithubCassette,
  params: { number: number | string; repo?: string },
) {
  const result = await prStatus(new GhClient(api.fetch, { token: async () => "test-token" }), {
    params,
    ctx: {},
  });
  if (!result.ok) {
    throw new Error(`prStatus failed: ${result.error}`);
  }
  return result.value;
}

describe("read-github-pr-status", () => {
  it("reports every check of the head commit with its run/job ids", async () => {
    const api = githubCassette(routes());
    const payload = await callPrStatus(api, { number: PR_NUMBER, repo: "trim21/pi-extensions" });
    // expectations come from the response this run served (replayed or recorded)
    const pull = api.body<PullFixture>(PULL_ROUTE);
    const combinedStatus = api.body<CombinedStatusFixture>(STATUS_ROUTE);
    const checkRuns = api.body<CheckRunsFixture>("check-runs");
    const [firstStatus] = combinedStatus.statuses;
    if (!firstStatus) {
      throw new Error("fixture has no commit status");
    }

    expect(payload.pr).toBe(PR_NUMBER);
    expect(payload.repo).toBe("trim21/pi-extensions");
    expect(payload.head_sha).toBe(pull.head.sha);
    // every commit status and every check run of the commit shows up separately.
    // The suites add nothing here: GitHub creates one per app per commit, and
    // the ones with no check runs are unfinished shells (netlify, vercel, ...)
    // that never report anything.
    const suites = api.body<CheckSuitesFixture>("check-suites");
    expect(suites.check_suites.length).toBeGreaterThan(checkRuns.check_runs.length);
    expect(payload.checks).toHaveLength(
      combinedStatus.statuses.length + checkRuns.check_runs.length,
    );

    // Actions check runs carry the run/job ids from their details_url; the
    // commit statuses (codecov) have no Actions job behind them
    for (const check of payload.checks) {
      const isActionsJob = /\/actions\/runs\/\d+\/job\/\d+/.test(check.url ?? "");
      if (isActionsJob) {
        expect(check.run_id).toBeGreaterThan(0);
        expect(check.job_id).toBeGreaterThan(0);
      } else {
        expect(check.run_id).toBeNull();
        expect(check.job_id).toBeNull();
      }
      expect(["pass", "fail", "pending", "skipped"]).toContain(check.bucket);
    }

    const codecov = payload.checks.find((c) => c.name === firstStatus.context);
    expect(codecov).toMatchObject({
      bucket: "pass",
      run_id: null,
      job_id: null,
      url: firstStatus.target_url,
    });

    // same-named check runs stay distinct entries (push + pull_request triggers)
    const names = payload.checks.map((c) => c.name);
    expect(new Set(names).size).toBeLessThan(names.length);
    // ...and the Actions ones are labelled with the event that triggered them
    expect(payload.checks.some((c) => c.event === "pull_request")).toBe(true);

    expect(api.unused()).toEqual([]);
  });

  it("returns the snapshot immediately instead of polling", async () => {
    const api = githubCassette(routes());
    await callPrStatus(api, { number: PR_NUMBER, repo: "trim21/pi-extensions" });

    // one request per read (PR, commit statuses, check runs, run events) — a
    // polling implementation would repeat the check reads until they settle
    expect(api.calls.filter((url) => url.includes("check-runs"))).toHaveLength(1);
    expect(api.calls.filter((url) => url.includes("/status"))).toHaveLength(1);
    expect(api.calls.filter((url) => url.includes(PULL_ROUTE))).toHaveLength(1);
    expect(api.unused()).toEqual([]);
  });

  it("rejects a non-numeric PR number instead of asking the API", async () => {
    const api = githubCassette({});
    await expect(
      callPrStatus(api, { number: "abc", repo: "trim21/pi-extensions" }),
    ).rejects.toThrow(/invalid number/);
    expect(api.calls).toEqual([]);
  });

  it("lists workflows waiting for maintainer approval from their check suites", async () => {
    const api = githubCassette(forkRoutes());
    const payload = await callPrStatus(api, { number: FORK_PR_NUMBER, repo: FORK_REPO });
    const pull = api.body<PullFixture>("pulls/89");
    const checkRuns = api.body<CheckRunsFixture>("check-runs");
    const combinedStatus = api.body<CombinedStatusFixture>(STATUS_ROUTE);
    const suites = api.body<CheckSuitesFixture>("check-suites");
    const runs = api.body<WorkflowRunsFixture>(RUNS_ROUTE);

    expect(payload.pr).toBe(FORK_PR_NUMBER);
    expect(payload.repo).toBe(FORK_REPO);
    expect(payload.head_sha).toBe(pull.head.sha);

    // a suite already represented by check runs must not be listed separately
    const covered = new Set(checkRuns.check_runs.map((run) => run.check_suite.id));
    const orphanSuites = suites.check_suites.filter((suite) => !covered.has(suite.id));
    expect(orphanSuites.length).toBeGreaterThan(0);
    expect(payload.checks).toHaveLength(
      combinedStatus.statuses.length + checkRuns.check_runs.length + orphanSuites.length,
    );

    // every waiting workflow shows up, named and linked through its workflow run
    const runsBySuite = new Map(runs.workflow_runs.map((run) => [run.check_suite_id, run]));
    for (const suite of orphanSuites) {
      const run = runsBySuite.get(suite.id);
      expect(run, `suite ${String(suite.id)} has no workflow run in the fixture`).toBeDefined();
      expect(payload.checks).toContainEqual({
        name: run?.name,
        bucket: "action_required",
        event: run?.event,
        run_id: run?.id,
        job_id: null,
        suite_id: suite.id,
        url: run?.html_url,
      });
    }

    // check runs of a suite that did run carry that suite id
    const [dcoRun] = checkRuns.check_runs;
    const dco = payload.checks.find((c) => c.name === dcoRun?.name);
    expect(dco?.suite_id).toBe(dcoRun?.check_suite.id);
    expect(dco?.bucket).toBe("pass");

    expect(api.unused()).toEqual([]);
  });
});
