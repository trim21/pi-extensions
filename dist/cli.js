#!/usr/bin/env node

// bin/cli.ts
import { execSync } from "node:child_process";

// src/gh-readonly.ts
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
function statusIcon(conclusion) {
  switch (conclusion) {
    case "success":
      return "\u2705";
    case "failure":
      return "\u274C";
    case "cancelled":
      return "\u{1F6AB}";
    case "skipped":
      return "\u23ED\uFE0F";
    case "timed_out":
      return "\u23F0";
    case "action_required":
      return "\u26A0\uFE0F";
    default:
      return "\u{1F504}";
  }
}
function extractStepFromLog(log, stepNumber, apiSteps) {
  const targetStep = apiSteps.find((s) => s.number === stepNumber);
  if (!targetStep) return null;
  const lines2 = log.split("\n");
  if (stepNumber === 1) {
    let depth2 = 0;
    for (let i = 0; i < lines2.length; i++) {
      const line = lines2[i];
      if (line.includes("##[endgroup]")) {
        if (depth2 > 0) depth2--;
        continue;
      }
      if (line.includes("##[group]")) {
        depth2++;
        if (depth2 === 1) {
          const m = line.match(/##\[group\](.*)/);
          const name = m ? m[1].trim() : "";
          if (name.startsWith("Run ") || name.startsWith("Post Run ")) {
            return lines2.slice(0, i).join("\n").trimEnd();
          }
        }
      }
    }
    return lines2.join("\n").trimEnd();
  }
  const stepAction = targetStep.name.replace(/^(Run |Post Run )/, "").trim();
  const groups = [];
  let depth = 0;
  for (let i = 0; i < lines2.length; i++) {
    const line = lines2[i];
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
  const matchedIdx = groups.findIndex((g) => g.action === stepAction);
  if (matchedIdx === -1) return null;
  const start = groups[matchedIdx].line;
  const end = matchedIdx + 1 < groups.length ? groups[matchedIdx + 1].line : lines2.length;
  return lines2.slice(start, end).join("\n").trimEnd();
}

// bin/cli.ts
function gh(args2) {
  return execSync(`gh ${args2.join(" ")}`, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
var args = process.argv.slice(2);
var input = args[0];
var stepName = args.includes("--step") ? args[args.indexOf("--step") + 1] : void 0;
var offset = args.includes("--offset") ? Number(args[args.indexOf("--offset") + 1]) : void 0;
var limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : void 0;
if (!input) {
  console.error("Usage: ci-log <url> [--step name] [--offset N] [--limit N]");
  process.exit(1);
}
var jobMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)/);
var runMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
var owner;
var repoName;
var runId;
var jobId;
if (jobMatch) [, owner, repoName, runId, jobId] = jobMatch;
else if (runMatch) [, owner, repoName, runId] = runMatch;
else {
  console.error("Invalid GitHub Actions URL.");
  process.exit(1);
}
var effectiveRepo = `${owner}/${repoName}`;
var jobsResult = gh(["api", `/repos/${effectiveRepo}/actions/runs/${runId}/jobs`]);
var { jobs } = JSON.parse(jobsResult);
if (!jobs?.length) {
  console.error("No jobs found.");
  process.exit(1);
}
function fetchFailedLogs(j, maxLogs) {
  const failed = j.steps.filter((s) => s.conclusion === "failure");
  if (!failed.length) return "";
  let out2 = "";
  let count = 0;
  try {
    const rawLog2 = gh(["api", `/repos/${effectiveRepo}/actions/jobs/${j.id}/logs`]);
    for (const fs of failed) {
      if (count >= maxLogs) break;
      const stepLog2 = extractStepFromLog(rawLog2, fs.number, j.steps);
      if (!stepLog2) continue;
      count++;
      const lines2 = stepLog2.split("\n");
      const shown = lines2.slice(0, 500);
      out2 += `
### \u274C ${j.name} / ${fs.name} (step ${fs.number})
Total: ${lines2.length} lines | Shown: ${shown.length} lines

`;
      out2 += shown.join("\n") + "\n";
    }
  } catch {}
  return out2;
}
var targetJobs = jobId ? jobs.filter((j) => String(j.id) === jobId) : jobs;
if (!targetJobs.length) {
  console.error(`Job ${jobId} not found.`);
  process.exit(1);
}
if (!stepName) {
  console.log(`## CI Summary for Run ${runId}
`);
  let failedCount = 0;
  for (const j of targetJobs) {
    console.log(
      `### ${statusIcon(j.conclusion)} ${j.name} (id: ${j.id}) \u2014 ${j.conclusion ?? j.status}
`,
    );
    console.log(`| Step# | Name | Status |`);
    console.log(`|-------|------|--------|`);
    for (const s of j.steps ?? []) {
      console.log(
        `| ${s.number} | ${s.name} | ${statusIcon(s.conclusion)} ${s.conclusion ?? s.status} |`,
      );
    }
    console.log();
    if (failedCount < 5) {
      const logs = fetchFailedLogs(j, 5 - failedCount);
      if (logs) {
        console.log(logs);
        failedCount += j.steps.filter((s) => s.conclusion === "failure").length;
      }
    }
  }
  process.exit(0);
}
var targetJob = targetJobs[0];
var found = targetJob.steps?.find((s) => s.name.toLowerCase() === stepName.toLowerCase());
if (!found) {
  console.error(
    `Step "${stepName}" not found. Available: ${targetJob.steps?.map((s) => `${s.name} (${s.number})`).join(", ")}`,
  );
  process.exit(1);
}
var rawLog = gh(["api", `/repos/${effectiveRepo}/actions/jobs/${targetJob.id}/logs`]);
var stepLog = extractStepFromLog(rawLog, found.number, targetJob.steps ?? []);
if (!stepLog) {
  console.error(`Could not extract step ${found.number} from log.`);
  process.exit(1);
}
var lines = stepLog.split("\n");
var out = lines;
if (offset) out = out.slice(offset - 1);
if (limit) out = out.slice(0, limit);
console.log(`## ${targetJob.name} / ${stepName} (step ${found.number})`);
console.log(`Total: ${lines.length} lines | Shown: ${out.length} lines`);
console.log();
console.log(out.join("\n"));
