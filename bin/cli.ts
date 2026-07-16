#!/usr/bin/env node
import { execSync } from "node:child_process";
import { extractStepFromLog, statusIcon } from "../src/gh-readonly";

function gh(args: string[]): string {
  return execSync(`gh ${args.join(" ")}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

type Job = { id: number; name: string; status: string; conclusion: string | null; steps: Step[] };
type Step = { name: string; number: number; status: string; conclusion: string | null };

const args = process.argv.slice(2);
const input = args[0];
const stepName = args.includes("--step") ? args[args.indexOf("--step") + 1] : undefined;
const offset = args.includes("--offset") ? Number(args[args.indexOf("--offset") + 1]) : undefined;
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : undefined;

if (!input) {
  console.error("Usage: ci-log <url> [--step name] [--offset N] [--limit N]");
  process.exit(1);
}

const jobMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)/);
const runMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);

let owner: string, repoName: string, runId: string, jobId: string | undefined;
if (jobMatch) [, owner, repoName, runId, jobId] = jobMatch;
else if (runMatch) [, owner, repoName, runId] = runMatch;
else {
  console.error("Invalid GitHub Actions URL.");
  process.exit(1);
}

const effectiveRepo = `${owner}/${repoName}`;
const jobsResult = gh(["api", `/repos/${effectiveRepo}/actions/runs/${runId}/jobs`]);
const { jobs } = JSON.parse(jobsResult) as { jobs: Job[] };
if (!jobs?.length) {
  console.error("No jobs found.");
  process.exit(1);
}

// ── Fetch failed step logs for a job ──
function fetchFailedLogs(j: Job, maxLogs: number): string {
  const failed = j.steps.filter((s) => s.conclusion === "failure");
  if (!failed.length) return "";

  let out = "";
  let count = 0;
  try {
    const rawLog = gh(["api", `/repos/${effectiveRepo}/actions/jobs/${j.id}/logs`]);
    for (const fs of failed) {
      if (count >= maxLogs) break;
      const stepLog = extractStepFromLog(rawLog, fs.number, j.steps);
      if (!stepLog) continue;
      count++;
      const lines = stepLog.split("\n");
      const shown = lines.slice(0, 500); // tighter for auto-include
      out += `\n### ❌ ${j.name} / ${fs.name} (step ${fs.number})\nTotal: ${lines.length} lines | Shown: ${shown.length} lines\n\n`;
      out += shown.join("\n") + "\n";
    }
  } catch {
    /* skip if log fetch fails */
  }
  return out;
}

// ── Run-level: show all jobs + auto-include failed logs ──
const targetJobs: Job[] = jobId ? jobs.filter((j) => String(j.id) === jobId) : jobs;
if (!targetJobs.length) {
  console.error(`Job ${jobId} not found.`);
  process.exit(1);
}

if (!stepName) {
  console.log(`## CI Summary for Run ${runId}\n`);
  let failedCount = 0;
  for (const j of targetJobs) {
    console.log(
      `### ${statusIcon(j.conclusion)} ${j.name} (id: ${j.id}) — ${j.conclusion ?? j.status}\n`,
    );
    console.log(`| Step# | Name | Status |`);
    console.log(`|-------|------|--------|`);
    for (const s of j.steps ?? []) {
      console.log(
        `| ${s.number} | ${s.name} | ${statusIcon(s.conclusion)} ${s.conclusion ?? s.status} |`,
      );
    }
    console.log();

    // Auto-include failed step logs (up to 5 total across all jobs)
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

// ── Step-level ──
const targetJob = targetJobs[0];
const found = targetJob.steps?.find((s) => s.name.toLowerCase() === stepName.toLowerCase());
if (!found) {
  console.error(
    `Step "${stepName}" not found. Available: ${targetJob.steps?.map((s) => `${s.name} (${s.number})`).join(", ")}`,
  );
  process.exit(1);
}

const rawLog = gh(["api", `/repos/${effectiveRepo}/actions/jobs/${targetJob.id}/logs`]);
const stepLog = extractStepFromLog(rawLog, found.number, targetJob.steps ?? []);
if (!stepLog) {
  console.error(`Could not extract step ${found.number} from log.`);
  process.exit(1);
}

const lines = stepLog.split("\n");
let out = lines;
if (offset) out = out.slice(offset - 1);
if (limit) out = out.slice(0, limit);

console.log(`## ${targetJob.name} / ${stepName} (step ${found.number})`);
console.log(`Total: ${lines.length} lines | Shown: ${out.length} lines`);
console.log();
console.log(out.join("\n"));
