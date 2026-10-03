/**
 * Tests for the Actions jobs reads of the octokit checks client
 * (`src/lib/github.ts`): `runJobs` must return the jobs of *every* page — the
 * endpoint defaults to 30 items per page, so a run with more jobs used to hide
 * the rest from the CI-log tools — and `job` must return one job by id.
 *
 * Responses come from recorded fixtures (see test/github-fixtures.ts), injected
 * into the client: these tests never touch the network. The auth token is
 * injected too, so no `gh` process is spawned either.
 *
 * Run: npx vitest run test/github-jobs.test.ts
 * Re-record: RECORD_GITHUB=1 pnpm exec vitest run --testTimeout=60000 test/github-jobs.test.ts
 */
import { describe, expect, it } from "vitest";

import { createGithubApi, createGithubChecks } from "../src/lib/github.js";
import { githubCassette } from "./github-fixtures.js";

const RUN_ID = 34773404718;
const JOB_ID = 103767009687;

interface JobFixture {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: { name: string; number: number; started_at?: string | null }[];
}

const JOBS_ROUTE = `actions/runs/${String(RUN_ID)}/jobs`;
const JOB_ROUTE = "actions/jobs/";

describe("createGithubChecks runJobs", () => {
  it("returns the jobs of every page, not just the first page", async () => {
    // A two-page jobs listing: the run recorded in run-jobs.json has a handful
    // of jobs, so the pages are spelled out here rather than pretending the
    // endpoint would page a six-job run.
    const page1Job: JobFixture = {
      id: 103767009595,
      run_id: RUN_ID,
      name: "lint",
      status: "completed",
      conclusion: "success",
      steps: [{ name: "Run pnpm run lint", number: 6, started_at: "2026-09-13T18:03:03Z" }],
    };
    const page2Job: JobFixture = {
      id: 103767009687,
      run_id: RUN_ID,
      name: "test (24)",
      status: "completed",
      conclusion: "failure",
      steps: [{ name: "Run pnpm test:coverage", number: 8, started_at: "2026-09-13T18:03:11Z" }],
    };
    const page2 = `https://api.github.com/repos/trim21/pi-extensions/actions/runs/${String(RUN_ID)}/jobs?per_page=100&page=2`;
    const api = githubCassette({
      // must come first: the page-2 URL also contains the page-1 route
      "page=2": { body: { total_count: 2, jobs: [page2Job] } },
      [JOBS_ROUTE]: {
        body: { total_count: 2, jobs: [page1Job] },
        headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
      },
    });

    const jobs = await createGithubChecks(
      createGithubApi({
        fetch: api.fetch,
        token: async () => "test-token",
      }),
    ).runJobs("trim21", "pi-extensions", RUN_ID, undefined);

    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]).toContain("per_page=100");
    expect(api.unused()).toEqual([]);
    // every page reaches the caller, in order
    expect(jobs.map((job) => job.name)).toEqual(["lint", "test (24)"]);
    expect(jobs[0]).toMatchObject({ id: page1Job.id, run_id: RUN_ID, conclusion: "success" });
    expect(jobs[1]).toMatchObject({ id: page2Job.id, run_id: RUN_ID, conclusion: "failure" });
    expect(jobs[0]?.steps.map((step) => step.name)).toEqual(["Run pnpm run lint"]);
  });
});

describe("createGithubChecks job", () => {
  it("returns one job by id, steps included", async () => {
    const api = githubCassette({ [JOB_ROUTE]: "job.json" });

    const job = await createGithubChecks(
      createGithubApi({
        fetch: api.fetch,
        token: async () => "test-token",
      }),
    ).job("trim21", "pi-extensions", JOB_ID, undefined);

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toContain(`/repos/trim21/pi-extensions/actions/jobs/${String(JOB_ID)}`);
    expect(api.unused()).toEqual([]);
    const recorded = api.body<JobFixture>(JOB_ROUTE);
    expect(job).toMatchObject({
      id: recorded.id,
      run_id: recorded.run_id,
      name: recorded.name,
      status: recorded.status,
      conclusion: recorded.conclusion,
    });
    // steps keep their order and carry the started_at the log index matches on
    expect(job.steps.map((step) => step.name)).toEqual(recorded.steps.map((step) => step.name));
    expect(job.steps.every((step) => step.started_at !== undefined)).toBe(true);
  });
});
