/**
 * Tests for the `read-github-ci-logs` rendering core — the pure functions
 * `renderJobLogs` / `renderStepLog` / `cleanStepOutput` used by the tool's
 * `execute()`.
 *
 * Fixtures are a real workflow run (trim21/php-serialize #31026014828, PR #303),
 * so the snapshots lock the exact output shape: without `step` the tool returns
 * a JSON array of jobs `[{ name, steps: [{ name, output? }] }]` where only
 * failed steps carry an `output`; with `step` (and `job`) it returns that
 * step's complete log as plain text.
 * `php-serialize-92374541920-raw.log` is the failing `lint` job and
 * `php-serialize-92374541741-raw.log` the failing `test` job.
 *
 * Run: npx vitest run test/ci-logs.test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type CiLogsJob,
  cleanStepOutput,
  extractStepFromLog,
  renderJobLogs,
  renderStepLog,
  stripAnsi,
  writeLogFile,
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

function fetchJobLog(jobId: number): Promise<string> {
  switch (jobId) {
    case 92374541920: {
      return Promise.resolve(lintRawLog);
    }
    case 92374541741: {
      return Promise.resolve(testRawLog);
    }
    default: {
      return Promise.reject(new Error(`no fixture for job ${jobId}`));
    }
  }
}

describe("cleanStepOutput", () => {
  it("strips timestamps, ANSI escapes and group markers", () => {
    const raw = [
      "\uFEFF2026-08-05T16:36:08.1842645Z ##[group]Run npx prettier --check ./",
      "2026-08-05T16:36:08.1843040Z \u001B[36;1mnpx prettier --check ./\u001B[0m",
      "2026-08-05T16:36:08.1868383Z shell: /usr/bin/bash -e {0}",
      "2026-08-05T16:36:08.1869541Z ##[endgroup]",
      "2026-08-05T16:36:09.2942526Z Checking formatting...",
      "2026-08-05T16:36:09.8046392Z [\u001B[33mwarn\u001B[39m] pnpm-lock.yaml",
      "2026-08-05T16:36:10.0260911Z ##[error]Process completed with exit code 1.",
    ].join("\n");

    expect(cleanStepOutput(raw)).toBe(
      [
        "npx prettier --check ./",
        "shell: /usr/bin/bash -e {0}",
        "Checking formatting...",
        "[warn] pnpm-lock.yaml",
        "##[error]Process completed with exit code 1.",
      ].join("\n"),
    );
  });
});

describe("renderJobLogs", () => {
  it("returns a JSON array of jobs; failed steps carry output", async () => {
    const result = await renderJobLogs({ runId: "31026014828" }, jobs, fetchJobLog);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // must be parseable JSON with the expected shape
    const parsed = JSON.parse(result.content[0].text) as {
      name: string;
      steps: { name: string; output?: string }[];
    }[];
    expect(parsed.map((j) => j.name)).toEqual(["test", "build", "lint"]);
    for (const job of parsed) {
      for (const step of job.steps) {
        expect(typeof step.name).toBe("string");
        if (step.output !== undefined) expect(typeof step.output).toBe("string");
      }
    }
    expect(result).toMatchSnapshot();
  });

  it("filters to a single job with job=lint", async () => {
    const result = await renderJobLogs({ runId: "31026014828", job: "lint" }, jobs, fetchJobLog);
    const parsed = JSON.parse(result.content[0].text) as { name: string }[];
    expect(parsed.map((j) => j.name)).toEqual(["lint"]);
    expect(result).toMatchSnapshot();
  });

  it("reports an unknown job name", async () => {
    const result = await renderJobLogs(
      { runId: "31026014828", job: "no-such-job" },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });

  it("reports an empty job list", async () => {
    const result = await renderJobLogs({ runId: "31026014828" }, [], fetchJobLog);
    expect(result).toMatchSnapshot();
  });
});

describe("renderStepLog", () => {
  it("requires job when fetching a step's logs", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", step: "Run npx prettier --check ./" },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });

  it("returns a failing step's complete plain-text log (lint step 6)", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "lint", step: "Run npx prettier --check ./" },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });

  it("returns a passing step's complete plain-text log (lint step 5)", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "lint", step: "Run pnpm install --frozen-lockfile" },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });

  it("matches job by id", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "92374541920", step: "Run npx prettier --check ./" },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });

  it("reports an unknown step name", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "lint", step: "no-such-step" },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });

  it("reports an unknown job name", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "no-such-job", step: "Run npx prettier --check ./" },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });
});

describe("renderStepLog (test job 92374541741)", () => {
  it("returns the failing test step's log (test step 6)", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "92374541741", step: "Run pnpm test --coverage" },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });

  it("extracts explicitly named action step (test step 4: Setup node)", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "test", step: "Setup node" },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });

  it("honors offset within a step log", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "test", step: "Run pnpm test --coverage", offset: 5 },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });

  it("reports offset beyond the step log length", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "test", step: "Run pnpm test --coverage", offset: 9999 },
      jobs,
      fetchJobLog,
    );
    expect(result).toMatchSnapshot();
  });
});

describe("step log extraction integrity (lint job)", () => {
  it("failing step 6 contains the prettier error output", () => {
    const log = extractStepFromLog(lintRawLog, 6, lintJob.steps);
    expect(log).not.toBeNull();
    expect(log).toContain("##[error]Process completed with exit code 1.");
    expect(log).toContain("pnpm-lock.yaml");
  });

  it("step 5 (pnpm install) contains its own output only", () => {
    const log = extractStepFromLog(lintRawLog, 5, lintJob.steps);
    expect(log).not.toBeNull();
    expect(log).toContain("##[group]Run pnpm install --frozen-lockfile");
    expect(log).not.toContain("prettier --check");
  });

  it("skipped steps (not present in the log) return null", () => {
    // lint step 7 was skipped because step 6 failed — no "Run npx tsc" group in the log
    expect(extractStepFromLog(lintRawLog, 7, lintJob.steps)).toBeNull();
  });

  it("explicitly named action steps (Setup node) extract from the matching Run group", () => {
    // API step 4 is named "Setup node" but the log group is "Run actions/setup-node@v7"
    const log = extractStepFromLog(lintRawLog, 4, lintJob.steps);
    expect(log).not.toBeNull();
    expect(log).toContain("##[group]Run actions/setup-node@v7");
  });
});

describe("test job extraction", () => {
  it("failing step 6 (pnpm test --coverage) contains the failure", () => {
    const log = extractStepFromLog(testRawLog, 6, testJob.steps);
    expect(log).not.toBeNull();
    expect(log).toContain("##[group]Run pnpm test --coverage");
    expect(log).toContain("##[error]Process completed with exit code 1.");
  });

  it("explicitly named step 4 (Setup node) extracts its Run group", () => {
    const log = extractStepFromLog(testRawLog, 4, testJob.steps);
    expect(log).not.toBeNull();
    expect(log).toContain("##[group]Run actions/setup-node@v7");
    expect(log).not.toContain("pnpm install");
  });

  it("skipped step 7 (Upload Coverage to Codecov) returns null", () => {
    expect(extractStepFromLog(testRawLog, 7, testJob.steps)).toBeNull();
  });
});

describe("composite action step extraction (winflexbison cibuildwheel)", () => {
  // Regression: composite actions emit their internal steps as extra depth-1
  // "Run " groups AFTER the composite's own ##[endgroup]. The extractor must
  // absorb them into the composite step's span instead of treating them as
  // step boundaries, otherwise the composite step's log is truncated.
  const rawLog = loadFixture("winflexbison-cibuildwheel-raw.log");
  const steps = [
    { number: 1, name: "Set up job" },
    { number: 2, name: "Run actions/download-artifact@v8" },
    { number: 3, name: "Run mkdir -p package" },
    { number: 4, name: "Run astral-sh/setup-uv@v9.0.0" },
    { number: 5, name: "Run pypa/cibuildwheel@v4.2.0" },
    { number: 13, name: "Post Run pypa/cibuildwheel@v4.2.0" },
    { number: 15, name: "Complete job" },
  ];

  it("step 5 (cibuildwheel) includes its internal composite groups", () => {
    const log = extractStepFromLog(rawLog, 5, steps);
    expect(log).not.toBeNull();
    expect(log).toContain("##[group]Run pypa/cibuildwheel@v4.2.0");
    expect(log).toContain("##[group]Run actions/setup-python@");
    expect(log).toContain("Building wheel...");
  });

  it("preceding step 4 ends where step 5 begins", () => {
    const log = extractStepFromLog(rawLog, 4, steps);
    expect(log).not.toBeNull();
    expect(log).toContain("##[group]Run astral-sh/setup-uv@v9.0.0");
    expect(log).not.toContain("cibuildwheel");
  });
});

describe("stripAnsi", () => {
  it("removes the BOM and ANSI escapes but keeps timestamps and group markers", () => {
    const raw = [
      "\uFEFF2026-08-05T16:36:08.1842645Z ##[group]Run npx prettier --check ./",
      "2026-08-05T16:36:08.1843040Z \u001B[36;1mnpx prettier --check ./\u001B[0m",
      "2026-08-05T16:36:09.2942526Z Checking formatting...",
    ].join("\n");

    expect(stripAnsi(raw)).toBe(
      [
        "2026-08-05T16:36:08.1842645Z ##[group]Run npx prettier --check ./",
        "2026-08-05T16:36:08.1843040Z npx prettier --check ./",
        "2026-08-05T16:36:09.2942526Z Checking formatting...",
      ].join("\n"),
    );
  });
});

describe("renderStepLog full", () => {
  // 600 output lines — beyond the default 500-line cap, so the difference
  // between `full` and the default truncation is observable.
  const bigStepLog = [
    "2026-08-05T16:36:08.1842645Z ##[group]Run npx prettier --check ./",
    ...Array.from({ length: 600 }, (_, i) => `2026-08-05T16:36:08.1842645Z output line ${i}`),
    "2026-08-05T16:36:08.1842645Z ##[endgroup]",
  ].join("\n");
  const fetchBig = () => Promise.resolve(bigStepLog);

  it("full=true returns the complete output past the default cap", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "lint", step: "Run npx prettier --check ./", full: true },
      jobs,
      fetchBig,
    );
    const text = result.content[0].text;
    expect(text.split("\n")).toHaveLength(600);
    expect(text).toContain("output line 599");
    expect(result.details).toMatchObject({
      truncated: false,
      full: true,
      totalLines: 600,
      shownLines: 600,
    });
  });

  it("without full the same log is truncated to the default cap", async () => {
    const result = await renderStepLog(
      { runId: "31026014828", job: "lint", step: "Run npx prettier --check ./" },
      jobs,
      fetchBig,
    );
    const text = result.content[0].text;
    expect(text.split("\n")).toHaveLength(500);
    expect(result.details.truncated).toBe(true);
    expect(text).not.toContain("output line 599");
  });
});

describe("renderJobLogs full", () => {
  it("full=true expands every step's output, including successful ones", async () => {
    const result = await renderJobLogs(
      { runId: "31026014828", job: "lint", full: true },
      jobs,
      fetchJobLog,
    );
    const parsed = JSON.parse(result.content[0].text) as {
      name: string;
      steps: { name: string; output?: string }[];
    }[];
    expect(parsed).toHaveLength(1);
    const steps = new Map(parsed[0].steps.map((s) => [s.name, s]));

    // successful steps carry output under full
    expect(steps.get("Run pnpm install --frozen-lockfile")?.output).toBeDefined();
    expect(steps.get("Run actions/checkout@v7")?.output).toBeDefined();
    // skipped steps that never ran in the log have no group → no output
    expect(steps.get("Run npx tsc --pretty")?.output).toBeUndefined();

    expect(result.details.full).toBe(true);
    expect(result.details.summary).toContain("full, untruncated");
  });

  it("without full, successful steps carry no output", async () => {
    const result = await renderJobLogs({ runId: "31026014828", job: "lint" }, jobs, fetchJobLog);
    const parsed = JSON.parse(result.content[0].text) as {
      steps: { name: string; output?: string }[];
    }[];
    const steps = new Map(parsed[0].steps.map((s) => [s.name, s]));
    expect(steps.get("Run pnpm install --frozen-lockfile")?.output).toBeUndefined();
  });
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ci-logs-test-"));
}

describe("writeLogFile", () => {
  it("writes a job's complete log (timestamps kept, ANSI stripped)", async () => {
    const dir = tempDir();
    try {
      const outputFile = join(dir, "nested", "lint.log");
      const result = await writeLogFile(
        { runId: "31026014828", job: "lint", outputFile },
        jobs,
        fetchJobLog,
        undefined,
        {},
      );
      expect(result.details).toMatchObject({
        lines: expect.any(Number),
        bytes: expect.any(Number),
      });

      const written = readFileSync(join(dir, "nested", "lint.log"), "utf8");
      expect(written).toContain("##[group]Run npx prettier --check ./");
      expect(written).toContain("2026-08-05T16:36:");
      expect(written).not.toContain("\u001B[");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a single step's cleaned output", async () => {
    const dir = tempDir();
    try {
      const outputFile = join(dir, "step6.log");
      const result = await writeLogFile(
        {
          runId: "31026014828",
          job: "lint",
          step: "Run npx prettier --check ./",
          outputFile,
        },
        jobs,
        fetchJobLog,
        undefined,
        {},
      );
      expect(result.details).toMatchObject({ lines: expect.any(Number) });

      const written = readFileSync(join(dir, "step6.log"), "utf8");
      expect(written).toContain("##[error]Process completed with exit code 1.");
      expect(written).not.toContain("##[group]");
      expect(written).not.toContain("2026-08-05T16:36:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires a unique job when the run has several", async () => {
    const result = await writeLogFile(
      { runId: "31026014828", outputFile: join(tmpdir(), "x.log") },
      jobs,
      fetchJobLog,
      undefined,
      {},
    );
    expect(result.content[0].text).toContain("matches 3 jobs");
  });

  it("reports an unknown job", async () => {
    const result = await writeLogFile(
      { runId: "31026014828", job: "no-such-job", outputFile: join(tmpdir(), "x.log") },
      jobs,
      fetchJobLog,
      undefined,
      {},
    );
    expect(result.content[0].text).toContain('Job "no-such-job" not found');
  });

  it("reports a queued job", async () => {
    const queuedJobs = [{ ...jobs[0], status: "queued" }];
    const result = await writeLogFile(
      { runId: "31026014828", job: "test", outputFile: join(tmpdir(), "x.log") },
      queuedJobs,
      fetchJobLog,
      undefined,
      {},
    );
    expect(result.content[0].text).toContain("still queued");
  });
});
