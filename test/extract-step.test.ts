/**
 * `jobLogIndex` 对 fuzz-download-2 这个 job 的 step 行范围断言：该 job 的 step 3 是
 * 复合 action，会在日志里额外产出 depth-1 的 "Run " 组；紧接着的 step 4、5、6 必须
 * 各自落到正确的块（step 5 / 6 被跳过，根本没有块）。
 *
 * Run: npx vitest run test/extract-step.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { jobLogIndex } from "../src/gh/index.js";
import { type RunJob } from "../src/lib/github.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

function firstLine(text: string): string {
  const m = /^.*$/m.exec(text);
  return m ? m[0].trim() : "";
}

const job = JSON.parse(loadFixture("fuzz-download-2-job.json")) as RunJob;
const log = loadFixture("fuzz-download-2-raw.log");
const index = jobLogIndex(job, log);

/** 模型读到的内容：按 jobLogIndex 给出的行范围从原始日志里切出该 step。 */
function stepText(stepNumber: number): string | null {
  const step = index.steps.find((s) => s.number === stepNumber);
  if (step?.start_line === undefined || step.end_line === undefined) {
    return null;
  }
  return log
    .split("\n")
    .slice(step.start_line - 1, step.end_line)
    .join("\n")
    .trimEnd();
}

describe("jobLogIndex — fuzz-download-2 job", () => {
  it("job has expected step 4", () => {
    const step4 = job.steps.find((s) => s.number === 4);
    expect(step4).toBeDefined();
    expect(step4!.name).toContain("FuzzPickerDownloadIntegration");
  });

  describe("step 1 (Set up job)", () => {
    it("covers the runner preamble and no Run group", () => {
      const text = stepText(1);
      expect(text).toContain("Runner Image Provisioner");
      expect(text).not.toMatch(/##\[group\]Run /);
    });
  });

  describe("step 2 (Run actions/checkout@v7.0.0)", () => {
    it("starts at the checkout group", () => {
      expect(stepText(2)).toContain("##[group]Run actions/checkout@v7.0.0");
    });
  });

  describe("step 3 (Run trim21/actions/setup-go@master)", () => {
    it("matches the composite action wrapper group", () => {
      const text = stepText(3);
      expect(text).toBeTruthy();
      expect(text).toContain("##[group]Run trim21/actions/setup-go@master");
    });
  });

  describe("step 4 (Run go test -race -fuzz=FuzzPickerDownloadIntegration)", () => {
    it("starts at the go test group, not a composite internal group", () => {
      const text = stepText(4);
      expect(text).toBeTruthy();
      expect(firstLine(text!)).toContain("Run go test -race -fuzz=FuzzPickerDownloadIntegration");
    });

    it("contains the FAIL output from the test run", () => {
      expect(stepText(4)).toMatch(/FAIL/);
    });

    it("does not contain setup-go output", () => {
      // setup-go prints "go version go1.26.5" — that belongs to step 3
      expect(stepText(4)).not.toMatch(/go version go1\./);
    });
  });

  // Steps 5 & 6 were skipped, so their "Run " groups never appear in the log and
  // they must get no range at all — not one stolen from a composite internal group.
  describe("skipped steps", () => {
    it("step 5 (Run go test -race -fuzz=FuzzStaleRequest) has no range", () => {
      expect(stepText(5)).toBeNull();
    });

    it("step 6 (Run go test -race -tags assert -fuzz=^FuzzFullDownload$) has no range", () => {
      expect(stepText(6)).toBeNull();
    });
  });
});

// ── Log structure analysis ──────────────────────────────────────────────────
describe("log structure analysis", () => {
  it("has more Run groups than API Run steps (composite action internal groups)", () => {
    const lines = log.split("\n");
    const runGroups: { line: number; name: string }[] = [];
    let depth = 0;
    for (const [i, line] of lines.entries()) {
      if (line.includes("##[endgroup]")) {
        if (depth > 0) {
          depth--;
        }
        continue;
      }
      if (!line.includes("##[group]")) {
        continue;
      }

      depth++;
      if (depth !== 1) {
        continue;
      }
      const m = /##\[group\](.*)/.exec(line);
      const name = m ? m[1].trim() : "";
      if (name.startsWith("Run ") || name.startsWith("Post Run ")) {
        runGroups.push({ line: i + 1, name });
      }
    }

    // 6 Run/Post Run groups in the log…
    expect(runGroups).toHaveLength(6);

    // …but 7 API steps have Run/Post Run prefix (5 Run + 2 Post Run)
    const apiRunSteps = job.steps.filter(
      (s) => s.name.startsWith("Run ") || s.name.startsWith("Post Run "),
    );
    expect(apiRunSteps).toHaveLength(7);

    // The 3 extra log groups (vs 5 API "Run" steps) are from composite action internals:
    // "Run actions/setup-go@v6", "Run actions/cache@v6", "Run go get ./..."
    const logRunNames = runGroups.map((g) => g.name);
    expect(logRunNames).toContain("Run actions/setup-go@v6");
    expect(logRunNames).toContain("Run actions/cache@v6");
    expect(logRunNames).toContain("Run go get ./...");
  });
});
