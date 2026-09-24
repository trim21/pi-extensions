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
  extractStepFromLog,
  jobLogIndex,
  jobLogPath,
  repoFromRunUrl,
  stepLineSpans,
} from "../src/gh-readonly.js";
import { type RunJob } from "../src/lib/github.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

const jobs = (JSON.parse(loadFixture("php-serialize-31026014828-jobs.json")) as { jobs: RunJob[] })
  .jobs;
const lintRawLog = loadFixture("php-serialize-92374541920-raw.log");
const testRawLog = loadFixture("php-serialize-92374541741-raw.log");

const lintJob = jobs.find((j) => j.id === 92374541920)!;
const testJob = jobs.find((j) => j.id === 92374541741)!;

function loadJob(name: string): RunJob {
  return JSON.parse(loadFixture(name)) as RunJob;
}

/**
 * Step number → the `##[group]` header its span starts at, `<preamble>` for the
 * runner-setup block before the first header, and `null` when the step has no
 * block at all. This is what the tool promises the model: one block per step
 * that actually produced log output.
 */
function stepBlocks(log: string, job: RunJob): [number, string | null][] {
  const spans = stepLineSpans(log, job.steps);
  const lines = log.split("\n");
  return job.steps.map((s) => {
    const span = spans.get(s.number);
    if (span === undefined) {
      return [s.number, null];
    }
    const line = (lines[span.start] ?? "").replace(/^\uFEFF?\S+Z /, "").replace(/\r$/, "");
    return [s.number, line.startsWith("##[group]") ? line.slice("##[group]".length) : "<preamble>"];
  });
}

/** The text a model gets by reading a step's line range out of the raw file. */
function readStepRange(log: string, job: RunJob, stepNumber: number): string | null {
  const step = jobLogIndex(job, log).steps.find((s) => s.number === stepNumber);
  if (step?.start_line === undefined || step.end_line === undefined) {
    return null;
  }
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
      if (step.start_line === undefined) {
        continue;
      }
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
  const job: RunJob = {
    id: 1,
    run_id: 1,
    run_url: "https://api.github.com/repos/winflexbison/winflexbison/actions/runs/1",
    name: "cibuildwheel",
    status: "completed",
    conclusion: "success",
    html_url: null,
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

// ── real logs from public repositories ──────────────────────────────────────
//
// These are trimmed excerpts of real job logs (public repos), keeping every
// `##[group]` / `##[endgroup]` line plus a few output lines per block, so line
// numbers differ from the originals while the structure and timestamps do not.
// Each one covers a shape the older fixtures missed.

describe("axonhub — every step has a custom name (no name matching possible)", () => {
  // looplj/axonhub run 32805492887 job 97674749621. Every step is declared with
  // `name:`, so no API step name equals its `##[group]Run <action-or-command>`
  // header — the previous name-based matcher gave all 11 steps the same span
  // from the first header to EOF.
  const job = loadJob("axonhub-97674749621-job.json");
  const log = loadFixture("axonhub-97674749621-raw.log");

  it("gives each executed step its own header block", () => {
    expect(stepBlocks(log, job)).toEqual([
      [1, "<preamble>"],
      [2, "Run actions/checkout@v7"],
      [3, "Run printf '%s\\n' \"${BASE_VERSION}-unstable.${BUILD_DATE}\" > internal/build/VERSION"],
      [4, "Run docker/setup-buildx-action@v4"],
      [5, "Run docker/login-action@v4"],
      [6, "Run docker/metadata-action@v6"],
      [7, "Run docker/build-push-action@v7"],
      // post/complete steps never emit a header of their own in this log
      [11, null],
      [12, null],
      [13, null],
      [14, null],
      [15, null],
    ]);
  });

  it("absorbs the action's own groups into the enclosing step", () => {
    const checkout = readStepRange(log, job, 2)!;
    expect(checkout).toContain("##[group]Getting Git version info");
    expect(checkout).toContain("##[group]Removing auth");
    expect(checkout).not.toContain("Docker info");

    const buildx = readStepRange(log, job, 4)!;
    expect(buildx).toContain("##[group]Docker info");
    expect(buildx).not.toContain("##[group]Run docker/login-action@v4");
  });
});

describe("libtorrent — CRLF log, no name matches, last group never closed", () => {
  // arvidn/libtorrent run 29188748619 job 86639594509 (Windows runner: CRLF).
  const job = loadJob("libtorrent-86639594509-job.json");
  const log = loadFixture("libtorrent-86639594509-raw.log");

  it("is a CRLF log", () => {
    expect(log).toContain("\r\n");
  });

  it("gives each executed step its own header block", () => {
    expect(stepBlocks(log, job)).toEqual([
      [1, "<preamble>"],
      [2, "Run actions/checkout@v6"],
      [
        3,
        "Run git clone --depth=1 --recurse-submodules -j10 --branch=boost-1.91.0 https://github.com/boostorg/boost.git",
      ],
      [4, "Run cd boost"],
      [5, String.raw`Run set BOOST_ROOT=%CD%\boost`],
      // skipped, post and complete steps have no block
      [6, null],
      [12, null],
      [13, null],
    ]);
  });

  it("keeps the trailing unclosed group inside the last step", () => {
    expect(readStepRange(log, job, 5)).toContain("##[group]test_pe_crypto.cpp.aes_ctr");
  });
});

describe("neptune — CRLF log with composite internals that look like headers", () => {
  // trim21/neptune run 29664454918 job 88132442135. Step 3 is a composite
  // action whose internal steps are emitted as depth-1 `Run ` groups; a later
  // step must not claim them.
  const job = loadJob("neptune-88132442135-job.json");
  const log = loadFixture("neptune-88132442135-raw.log");

  it("is a CRLF log", () => {
    expect(log).toContain("\r\n");
  });

  it("skips the composite's internal groups when matching later steps", () => {
    expect(stepBlocks(log, job)).toEqual([
      [1, "<preamble>"],
      [2, "Run actions/checkout@v7.0.0"],
      [3, "Run trim21/actions/setup-go@master"],
      [4, "Run jaxxstorm/action-install-gh-release@v3.0.0"],
      [
        5,
        "Run gotestsum --format=pkgname --format-hide-empty-pkg -- -short -race -count=1 -coverprofile=coverage.txt -covermode=atomic ./...",
      ],
      [6, null],
      [7, null],
      [8, null],
      [9, null],
      [10, null],
      [11, null],
      [12, null],
      [23, null],
      [24, null],
      [25, null],
    ]);
  });

  it("absorbs the composite's internal steps into the composite step", () => {
    const setup = readStepRange(log, job, 3)!;
    expect(setup).toContain("##[group]Run actions/setup-go@v6");
    expect(setup).toContain("##[group]Run actions/cache@v6");
    expect(setup).toContain("##[group]Run go get ./...");
    expect(setup).not.toContain("action-install-gh-release");
  });
});

describe("opendal — a skipped step must not take a running step's block", () => {
  // apache/opendal run 30707827656 job 91390443085. "Clear build" appears three
  // times (twice executed, once skipped) and "Run actions/checkout@v7" twice, so
  // name matching alone hands a skipped step a block that belongs to a step that
  // really ran.
  const job = loadJob("opendal-91390443085-job.json");
  const log = loadFixture("opendal-91390443085-raw.log");

  it("maps only the steps that produced output", () => {
    expect(stepBlocks(log, job)).toEqual([
      [1, "<preamble>"],
      [2, "Run actions/checkout@v7"],
      [3, "Run pnpm/action-setup@v6"],
      [4, "Run actions/setup-node@v6"],
      [5, "Run npm install -g --force corepack && corepack enable"],
      [6, "Run pnpm install --frozen-lockfile"],
      [7, "Run actions/download-artifact@v8"],
      [8, "Run # Useful for debugging"],
      [9, "Run actions/cache@v6"],
      [10, "Run pnpm build"],
      [11, null],
      [12, "Run rm -rf ./build"],
      [13, null],
      [14, null],
      [15, null],
      [16, null],
      [17, null],
      [18, "Run pnpm build"],
      [19, null],
      [20, "Run rm -rf ./build"],
      [21, "Run pnpm build"],
      [22, null],
      [41, null],
      [42, null],
      [43, null],
      [44, null],
      [45, null],
    ]);
  });
});

describe("overlay-s3 — several steps starting in the same second", () => {
  // trim21/overlay-s3 run 33060502066 job 98477797742. The API truncates step
  // timestamps to whole seconds, so the failing step 10, step 11 and the post
  // steps all start at 09:52:52; the blocks must still follow step order.
  const job = loadJob("overlay-s3-98477797742-job.json");
  const log = loadFixture("overlay-s3-98477797742-raw.log");

  it("keeps the failing step on its own block", () => {
    expect(stepBlocks(log, job)).toEqual([
      [1, "<preamble>"],
      [2, "Run actions/checkout@v7"],
      [3, "Run actions/setup-go@v7"],
      [4, "Run docker run -d --name silo -p 127.0.0.1:9000:9000 \\"],
      [5, "Run go build ./... && go vet ./..."],
      [6, "Run go test ./..."],
      [7, "Run go test -run TestIntegration -v ./..."],
      [8, "Run curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc"],
      [9, "Run go build -o overlay-s3 ."],
      [10, "Run set -euo pipefail"],
      [11, "Run docker logs silo 2>&1 | tail -200"],
      [21, null],
      [22, null],
      [23, null],
    ]);
  });
});
