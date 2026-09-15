/**
 * Tests for `read-github-pr-status` (the handler in `src/gh/tools/read-pr-status.ts`) —
 * it must return the
 * current checks of the PR's head commit immediately, without polling, and each
 * Actions-backed check has to carry the `run_id` / `job_id` that lead to its log.
 *
 * Responses come from recorded fixtures (see test/github-fixtures.ts), injected
 * into the client: these tests never touch the network nor `globalThis.fetch`.
 * Only `gh auth token` crosses a process boundary, and that spawn is stubbed.
 *
 * Run: npx vitest run test/pr-status.test.ts
 * Re-record: RECORD_GITHUB=1 pnpm exec vitest run --testTimeout=60000 test/pr-status.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// Partial mock: only the `gh auth token` spawn is stubbed; the cassette's own
// `execFileSync` (which reads the developer's token while recording) stays real.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { GhClient, prStatus } from "../src/gh-readonly.js";
import { type FixtureRoutes, type GithubCassette, githubCassette } from "./github-fixtures.js";

/** Fake `gh auth token` process. */
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
});

const PULL_ROUTE = "pulls/137";
const STATUS_ROUTE = "commits/";
const CHECK_RUNS_ROUTE = "check-runs";
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
  }[];
}

const PR_NUMBER = 137;

/** Route table shared by the tests in this file. */
function routes(): FixtureRoutes {
  return {
    [PULL_ROUTE]: "pull.json",
    "check-runs": "check-runs.json",
    // must come after check-runs, both live under /commits/<sha>/
    [STATUS_ROUTE]: "combined-status.json",
    [RUNS_ROUTE]: "workflow-runs.json",
  };
}

/** Run one toolcall through a client wired to the recorded responses. */
function callPrStatus(api: GithubCassette, params: { number: number | string; repo?: string }) {
  return prStatus(new GhClient(api.fetch), { params, ctx: {} });
}

describe("read-github-pr-status", () => {
  it("reports every check of the head commit with its run/job ids", async () => {
    const api = githubCassette(routes());
    const result = await callPrStatus(api, { number: PR_NUMBER, repo: "trim21/pi-extensions" });
    // expectations come from the response this run served (replayed or recorded)
    const pull = api.body<PullFixture>(PULL_ROUTE);
    const combinedStatus = api.body<CombinedStatusFixture>(STATUS_ROUTE);
    const checkRuns = api.body<CheckRunsFixture>("check-runs");
    const [firstStatus] = combinedStatus.statuses;
    if (!firstStatus) throw new Error("fixture has no commit status");
    const text = result.content[0]?.text ?? "";
    const payload = JSON.parse(text) as {
      pr: number;
      repo: string;
      head_sha: string;
      checks: {
        name: string;
        bucket: string;
        event: string | null;
        run_id: number | null;
        job_id: number | null;
        url: string | null;
      }[];
    };

    expect(payload.pr).toBe(PR_NUMBER);
    expect(payload.repo).toBe("trim21/pi-extensions");
    expect(payload.head_sha).toBe(pull.head.sha);
    // every commit status and every check run of the commit shows up separately
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
});
