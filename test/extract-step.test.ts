/**
 * Test for extractStepFromLog — reproduces the off-by-one bug
 * caused by composite actions producing extra "Run " groups.
 *
 * Run: npx vitest run test/extract-step.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

// ── types ───────────────────────────────────────────────────────────────────

interface StepInfo {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
}

// ── current (buggy) implementation ──────────────────────────────────────────

function extractStepFromLog_current(
  log: string,
  stepNumber: number,
  apiSteps: Array<{ number: number; name: string }>,
): string | null {
  const sorted = [...apiSteps].sort((a, b) => a.number - b.number);
  const stepIdx = sorted.findIndex((s) => s.number === stepNumber);
  if (stepIdx === -1) return null;

  const lines = log.split("\n");
  const runStarts: number[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("##[endgroup]")) {
      if (depth > 0) depth--;
      continue;
    }
    if (line.includes("##[group]")) {
      if (depth === 0) {
        const m = line.match(/##\[group\](.*)/);
        const name = m ? m[1].trim() : "";
        if (name.startsWith("Run ")) runStarts.push(i);
      }
      depth++;
    }
  }

  if (stepIdx === 0) {
    const end = runStarts.length > 0 ? runStarts[0] : lines.length;
    return lines.slice(0, end).join("\n").trimEnd();
  }

  const runIdx = stepIdx - 1;
  if (runIdx < 0 || runIdx >= runStarts.length) return null;

  const start = runStarts[runIdx];
  const end = runIdx + 1 < runStarts.length ? runStarts[runIdx + 1] : lines.length;
  return lines.slice(start, end).join("\n").trimEnd();
}

// ── fixed implementation — match by step name instead of index ──────────────

function extractStepFromLog_fixed(
  log: string,
  stepNumber: number,
  apiSteps: Array<{ number: number; name: string }>,
): string | null {
  const targetStep = apiSteps.find((s) => s.number === stepNumber);
  if (!targetStep) return null;

  const lines = log.split("\n");

  // Step 1 ("Set up job"): everything before the first "Run " or "Post Run " group at depth 1
  if (stepNumber === 1) {
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("##[endgroup]")) {
        if (depth > 0) depth--;
        continue;
      }
      if (line.includes("##[group]")) {
        depth++;
        if (depth === 1) {
          const m = line.match(/##\[group\](.*)/);
          const name = m ? m[1].trim() : "";
          if (name.startsWith("Run ") || name.startsWith("Post Run ")) {
            return lines.slice(0, i).join("\n").trimEnd();
          }
        }
      }
    }
    return lines.join("\n").trimEnd();
  }

  // Steps 2+: match "Run "/"Post Run " group by comparing the action name
  // (the part after "Run " or "Post Run " prefix)
  const stepAction = targetStep.name.replace(/^(Run |Post Run )/, "").trim();

  // Collect all "Run "/"Post Run " groups at depth 1
  const groups: Array<{ line: number; action: string }> = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("##[endgroup]")) {
      if (depth > 0) depth--;
      continue;
    }
    if (line.includes("##[group]")) {
      depth++;
      if (depth === 1) {
        const m = line.match(/##\[group\](.*)/);
        const name = m ? m[1].trim() : "";
        if (name.startsWith("Run ") || name.startsWith("Post Run ")) {
          const action = name.replace(/^(Run |Post Run )/, "").trim();
          groups.push({ line: i, action });
        }
      }
    }
  }

  // Find the matching group by action name
  const matchedIdx = groups.findIndex((g) => g.action === stepAction);
  if (matchedIdx === -1) return null;

  const start = groups[matchedIdx].line;
  const end = matchedIdx + 1 < groups.length ? groups[matchedIdx + 1].line : lines.length;
  return lines.slice(start, end).join("\n").trimEnd();
}

// ── helpers ─────────────────────────────────────────────────────────────────

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

function firstLine(text: string): string {
  const m = text.match(/^.*$/m);
  return m ? m[0].trim() : "";
}

// ── tests ───────────────────────────────────────────────────────────────────

const job = JSON.parse(loadFixture("fuzz-download-2-job.json")) as {
  id: number;
  name: string;
  conclusion: string | null;
  steps: StepInfo[];
};
const log = loadFixture("fuzz-download-2-raw.log");

describe("extractStepFromLog — fuzz-download-2 job", () => {
  it("job has expected step 4", () => {
    const step4 = job.steps.find((s) => s.number === 4);
    expect(step4).toBeDefined();
    expect(step4!.name).toContain("FuzzPickerDownloadIntegration");
  });

  // ── Step 1: "Set up job" ──────────────────────────────────────────────
  describe("step 1 (Set up job)", () => {
    it("both implementations agree", () => {
      const cur = extractStepFromLog_current(log, 1, job.steps);
      const fix = extractStepFromLog_fixed(log, 1, job.steps);
      expect(cur).toBe(fix);
      expect(cur).toContain("Runner Image Provisioner");
      // Step 1 should not contain any "Run " groups
      expect(cur).not.toMatch(/##\[group\]Run /);
    });
  });

  // ── Step 2: checkout ──────────────────────────────────────────────────
  describe("step 2 (Run actions/checkout@v7.0.0)", () => {
    it("both implementations agree", () => {
      const cur = extractStepFromLog_current(log, 2, job.steps);
      const fix = extractStepFromLog_fixed(log, 2, job.steps);
      expect(cur).toBe(fix);
      expect(cur).toContain("##[group]Run actions/checkout@v7.0.0");
    });
  });

  // ── Step 3: composite action ──────────────────────────────────────────
  describe("step 3 (Run trim21/actions/setup-go@master)", () => {
    it("fixed matches the composite action wrapper group", () => {
      const fix = extractStepFromLog_fixed(log, 3, job.steps);
      expect(fix).toBeTruthy();
      expect(fix).toContain("##[group]Run trim21/actions/setup-go@master");
    });
  });

  // ── Step 4: THE BUG ──────────────────────────────────────────────────
  describe("step 4 (Run go test -race -fuzz=FuzzPickerDownloadIntegration)", () => {
    it("BUG: current returns wrong content (setup-go, not go test)", () => {
      const cur = extractStepFromLog_current(log, 4, job.steps);
      expect(cur).toBeTruthy();
      expect(firstLine(cur!)).toContain("Run actions/setup-go@v6");
    });

    it("fixed returns correct go test content", () => {
      const fix = extractStepFromLog_fixed(log, 4, job.steps);
      expect(fix).toBeTruthy();
      expect(firstLine(fix!)).toContain("Run go test -race -fuzz=FuzzPickerDownloadIntegration");
    });

    it("fixed contains FAIL output from the test run", () => {
      const fix = extractStepFromLog_fixed(log, 4, job.steps);
      expect(fix).toMatch(/FAIL/);
    });

    it("fixed does NOT contain setup-go output", () => {
      const fix = extractStepFromLog_fixed(log, 4, job.steps);
      // setup-go prints "go version go1.26.5" — should not appear in step 4
      expect(fix).not.toMatch(/go version go1\./);
    });
  });

  // ── Steps 5 & 6: skipped (no log group because step 4 failed) ────────
  // Both steps were skipped — their "Run " groups never appear in the log.
  // The fixed implementation correctly returns null.
  // The current (buggy) index-based approach returns composite action internals.
  describe("step 5 (Run go test -race -fuzz=FuzzStaleRequest)", () => {
    it("fixed returns null — step was skipped, not in log", () => {
      const fix = extractStepFromLog_fixed(log, 5, job.steps);
      expect(fix).toBeNull();
    });

    it("BUG: current returns wrong content (composite action internals)", () => {
      const cur = extractStepFromLog_current(log, 5, job.steps);
      expect(cur).toBeTruthy();
      // Wrongly returns "Run actions/cache@v6" — an internal step of the composite action
      expect(firstLine(cur!)).toContain("Run actions/cache@v6");
      expect(cur).not.toContain("FuzzStaleRequest");
    });
  });

  describe("step 6 (Run go test -race -tags assert -fuzz=^FuzzFullDownload$)", () => {
    it("fixed returns null — step was skipped, not in log", () => {
      const fix = extractStepFromLog_fixed(log, 6, job.steps);
      expect(fix).toBeNull();
    });

    it("BUG: current returns wrong content (composite action internals)", () => {
      const cur = extractStepFromLog_current(log, 6, job.steps);
      expect(cur).toBeTruthy();
      // Wrongly returns "Run go get ./..." — an internal step of the composite action
      expect(firstLine(cur!)).toContain("Run go get ./...");
      expect(cur).not.toContain("FuzzFullDownload");
    });
  });
});

// ── Log structure analysis ──────────────────────────────────────────────────
describe("log structure analysis", () => {
  it("has more Run groups than API Run steps (composite action internal groups)", () => {
    const lines = log.split("\n");
    const runGroups: Array<{ line: number; name: string }> = [];
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("##[endgroup]")) {
        if (depth > 0) depth--;
        continue;
      }
      if (line.includes("##[group]")) {
        depth++;
        if (depth === 1) {
          const m = line.match(/##\[group\](.*)/);
          const name = m ? m[1].trim() : "";
          if (name.startsWith("Run ") || name.startsWith("Post Run ")) {
            runGroups.push({ line: i + 1, name });
          }
        }
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
