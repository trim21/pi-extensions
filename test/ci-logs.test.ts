/**
 * Tests for the `read-github-ci-logs` core — `jobLogIndex` / `stepLineSpans`,
 * the pure functions behind the tool's `execute()`.
 *
 * Fixtures are a real workflow run (trim21/php-serialize #31026014828, PR #303):
 * `php-serialize-92374541920-raw.log` is the failing `lint` job and
 * `php-serialize-92374541741-raw.log` the failing `test` job. The tool hands the
 * model each step's line range in the raw log file, so the tests focus on those
 * ranges resolving to the right blocks, plus the cache path derived from the
 * job's own `run_url` / `run_id`.
 *
 * Run: npx vitest run test/ci-logs.test.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type CiLogsJob,
  extractStepFromLog,
  jobLogIndex,
  jobLogPath,
  repoFromRunUrl,
  stepLineSpans,
} from "../src/gh-readonly.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

const jobs = (
  JSON.parse(loadFixture("php-serialize-31026014828-jobs.json")) as { jobs: CiLogsJob[] }
).jobs;
const lintRawLog = loadFixture("php-serialize-92374541920-raw.log");
const testRawLog = loadFixture("php-serialize-92374541741-raw.log");

const lintJob = jobs.find((j) => j.id === 92374541920)!;
const testJob = jobs.find((j) => j.id === 92374541741)!;

/** The text a model gets by reading a step's line range out of the raw file. */
function readStepRange(log: string, job: CiLogsJob, stepNumber: number): string | null {
  const step = jobLogIndex(job, log).steps.find((s) => s.number === stepNumber);
  if (step?.start_line === undefined || step.end_line === undefined) return null;
  return log
    .split("\n")
    .slice(step.start_line - 1, step.end_line)
    .join("\n")
    .trimEnd();
}

describe("jobLogIndex", () => {
  it("indexes a job's steps against its raw log file", () => {
    const index = jobLogIndex(lintJob, lintRawLog);
    expect(index).toMatchObject({
      name: "lint",
      id: 92374541920,
      status: "completed",
      conclusion: "failure",
      log_file: jobLogPath("trim21/php-serialize", "31026014828", 92374541920),
    });
    expect(index.steps.map((s) => s.number)).toEqual(lintJob.steps.map((s) => s.number));

    // every emitted range is inside the file and ordered
    const lines = lintRawLog.split("\n").length;
    for (const step of index.steps) {
      if (step.start_line === undefined) continue;
      expect(step.start_line).toBeGreaterThan(0);
      expect(step.end_line!).toBeGreaterThanOrEqual(step.start_line);
      expect(step.end_line!).toBeLessThanOrEqual(lines);
    }
  });

  it("gives every step's range the same text as the extraction helper", () => {
    for (const [job, log] of [
      [lintJob, lintRawLog],
      [testJob, testRawLog],
    ] as const) {
      for (const step of job.steps) {
        const expected = extractStepFromLog(log, step.number, job.steps);
        if (expected === null) {
          // steps that never ran carry no range at all
          expect(readStepRange(log, job, step.number)).toBeNull();
          continue;
        }
        expect(readStepRange(log, job, step.number)).toBe(expected);
      }
    }
  });

  it("leaves skipped steps without a range", () => {
    // lint step 7 ("Run npx tsc --pretty") was skipped after step 6 failed
    const index = jobLogIndex(lintJob, lintRawLog);
    const skipped = index.steps.find((s) => s.number === 7)!;
    expect(skipped.conclusion).toBe("skipped");
    expect(skipped.start_line).toBeUndefined();
    expect(skipped.end_line).toBeUndefined();
  });

  it("returns a JSON-serializable index", () => {
    const index = jobLogIndex(lintJob, lintRawLog);
    expect(structuredClone(index)).toEqual(index);
  });
});

describe("cache path", () => {
  it("derives the cache path from the job's repo/run ids", () => {
    expect(jobLogPath("trim21/php-serialize", "31026014828", 92374541920)).toBe(
      join(
        homedir(),
        ".cache",
        "pi",
        "github",
        "ci-logs",
        "trim21",
        "php-serialize",
        "31026014828",
        "92374541920.log",
      ),
    );
    expect(jobLogIndex(lintJob, lintRawLog).log_file).toBe(
      jobLogPath("trim21/php-serialize", "31026014828", 92374541920),
    );
  });

  it("reads owner/repo out of run_url, keeping GitHub's canonical casing", () => {
    expect(
      repoFromRunUrl(
        "https://api.github.com/repos/DefinitelyTyped/DefinitelyTyped/actions/runs/34756539354",
      ),
    ).toBe("DefinitelyTyped/DefinitelyTyped");
    // GHES serves the API under an instance-specific prefix before /repos
    expect(
      repoFromRunUrl("https://ghe.example.com/api/v3/repos/acme/widgets/actions/runs/42"),
    ).toBe("acme/widgets");
  });

  it("rejects a run_url without a /repos/<owner>/<repo> pair", () => {
    expect(() => repoFromRunUrl("https://api.github.com/user")).toThrow(/unexpected run_url/);
  });

  it("rejects a repo without exactly one slash", () => {
    expect(() => jobLogPath("trim21", "1", 2)).toThrow(/invalid repository/);
  });
});

describe("step blocks resolved from the raw log", () => {
  it("step 1 (Set up job) starts at line 1", () => {
    const index = jobLogIndex(lintJob, lintRawLog);
    expect(index.steps[0]).toMatchObject({ number: 1, name: "Set up job", start_line: 1 });
  });

  it("failing step 6 contains the prettier failure", () => {
    const text = readStepRange(lintRawLog, lintJob, 6)!;
    expect(text).toContain("##[group]Run npx prettier --check ./");
    expect(text).toContain("##[error]Process completed with exit code 1.");
    expect(text).toContain("pnpm-lock.yaml");
  });

  it("step 5 (pnpm install) contains its own output only", () => {
    const text = readStepRange(lintRawLog, lintJob, 5)!;
    expect(text).toContain("##[group]Run pnpm install --frozen-lockfile");
    expect(text).not.toContain("prettier --check");
  });

  it("explicitly named action step (Setup node) resolves to the matching Run group", () => {
    // API step 4 is named "Setup node" but the log group is "Run actions/setup-node@v7"
    const text = readStepRange(lintRawLog, lintJob, 4)!;
    expect(text).toContain("##[group]Run actions/setup-node@v7");
  });

  it("test job: failing step 6 contains the test failure", () => {
    const text = readStepRange(testRawLog, testJob, 6)!;
    expect(text).toContain("##[group]Run pnpm test --coverage");
    expect(text).toContain("##[error]Process completed with exit code 1.");
  });

  it("test job: skipped step 7 (Upload Coverage to Codecov) has no range", () => {
    expect(readStepRange(testRawLog, testJob, 7)).toBeNull();
  });
});

describe("composite action step ranges (winflexbison cibuildwheel)", () => {
  // Regression: composite actions emit their internal steps as extra depth-1
  // "Run " groups AFTER the composite's own ##[endgroup]. The range must absorb
  // them instead of ending at the first internal group.
  const rawLog = loadFixture("winflexbison-cibuildwheel-raw.log");
  const job: CiLogsJob = {
    id: 1,
    run_id: 1,
    run_url: "https://api.github.com/repos/winflexbison/winflexbison/actions/runs/1",
    name: "cibuildwheel",
    status: "completed",
    conclusion: "success",
    steps: [
      { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
      {
        number: 2,
        name: "Run actions/download-artifact@v8",
        status: "completed",
        conclusion: "success",
      },
      { number: 3, name: "Run mkdir -p package", status: "completed", conclusion: "success" },
      {
        number: 4,
        name: "Run astral-sh/setup-uv@v9.0.0",
        status: "completed",
        conclusion: "success",
      },
      {
        number: 5,
        name: "Run pypa/cibuildwheel@v4.2.0",
        status: "completed",
        conclusion: "success",
      },
      {
        number: 13,
        name: "Post Run pypa/cibuildwheel@v4.2.0",
        status: "completed",
        conclusion: "success",
      },
      { number: 15, name: "Complete job", status: "completed", conclusion: "success" },
    ],
  };

  it("step 5 (cibuildwheel) includes its internal composite groups", () => {
    const text = readStepRange(rawLog, job, 5)!;
    expect(text).toContain("##[group]Run pypa/cibuildwheel@v4.2.0");
    expect(text).toContain("##[group]Run actions/setup-python@");
    expect(text).toContain("Building wheel...");
  });

  it("preceding step 4 ends where step 5 begins", () => {
    const text = readStepRange(rawLog, job, 4)!;
    expect(text).toContain("##[group]Run astral-sh/setup-uv@v9.0.0");
    expect(text).not.toContain("cibuildwheel");

    const step4 = stepLineSpans(rawLog, job.steps).get(4)!;
    const step5 = stepLineSpans(rawLog, job.steps).get(5)!;
    expect(step4.end).toBeLessThanOrEqual(step5.start);
  });
});
