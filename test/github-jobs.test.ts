/**
 * Tests for the Actions jobs reads of the octokit checks client
 * (`src/lib/github.ts`): `runJobs` must return the jobs of *every* page — the
 * endpoint defaults to 30 items per page, so a run with more jobs used to hide
 * the rest from the CI-log tools — and `job` must return one job by id.
 *
 * Externals are stubbed: `gh auth token` (spawn) and the HTTP layer (fetch).
 *
 * Run: npx vitest run test/github-jobs.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { createGithubChecks } from "../src/lib/github.js";

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    return true;
  }
}

beforeEach(() => {
  spawnMock.mockImplementation(() => {
    const proc = new FakeChildProcess();
    setImmediate(() => {
      proc.stdout.write("test-token\n");
      proc.emit("close", 0);
    });
    return proc;
  });
});

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

/**
 * JSON response with its URL attached: octokit's paginate reads
 * `response.url` while normalizing a list payload.
 */
function jsonResponse(url: string, body: unknown, headers: Record<string, string> = {}): Response {
  const response = Response.json(body, { status: 200, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function apiJob(id: number, name: string) {
  return {
    id,
    run_id: 42,
    run_url: "https://api.github.com/repos/a/b/actions/runs/42",
    name,
    status: "completed",
    conclusion: "failure",
    html_url: `https://github.com/a/b/actions/runs/42/job/${String(id)}`,
    steps: [
      // `started_at` is optional in the API schema; the client fills in null
      { name: "Set up job", number: 1, status: "completed", conclusion: "success" },
      {
        name: "Run tests",
        number: 2,
        status: "completed",
        conclusion: "failure",
        started_at: "2026-09-05T03:12:01Z",
      },
    ],
  };
}

describe("createGithubChecks runJobs", () => {
  it("returns the jobs of every page, not just the first 30", async () => {
    const page2 = "https://api.github.com/repos/a/b/actions/runs/42/jobs?per_page=100&page=2";
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.includes("page=2")) {
        return Promise.resolve(jsonResponse(url, { total_count: 2, jobs: [apiJob(31, "run-31")] }));
      }
      return Promise.resolve(
        jsonResponse(
          url,
          { total_count: 2, jobs: [apiJob(1, "run-1")] },
          { link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
        ),
      );
    });

    const jobs = await createGithubChecks().runJobs("a", "b", 42, undefined);

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("per_page=100");
    expect(jobs.map((job) => job.name)).toEqual(["run-1", "run-31"]);
    expect(jobs[0]).toEqual({
      id: 1,
      run_id: 42,
      run_url: "https://api.github.com/repos/a/b/actions/runs/42",
      name: "run-1",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/a/b/actions/runs/42/job/1",
      steps: [
        {
          name: "Set up job",
          number: 1,
          status: "completed",
          conclusion: "success",
          started_at: null,
        },
        {
          name: "Run tests",
          number: 2,
          status: "completed",
          conclusion: "failure",
          started_at: "2026-09-05T03:12:01Z",
        },
      ],
    });
  });
});

describe("createGithubChecks job", () => {
  it("returns one job by id, steps included", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      return Promise.resolve(jsonResponse(url, apiJob(10, "lint")));
    });

    const job = await createGithubChecks().job("a", "b", 10, undefined);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/repos/a/b/actions/jobs/10");
    expect(job).toMatchObject({ id: 10, run_id: 42, name: "lint", conclusion: "failure" });
    expect(job.steps.map((step) => step.name)).toEqual(["Set up job", "Run tests"]);
  });
});
