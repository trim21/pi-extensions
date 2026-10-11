import { Type } from "typebox";

import { type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  mergeChecks,
  resolveRepoTarget,
  structuredResult,
  type ToolCall,
  toPositiveId,
} from "../base.js";
import { prStatusSchema } from "../schemas.js";

interface PrStatusParams {
  number: number | string;
  repo?: string;
}

/**
 * `read-github-pr-status`: the PR head commit's checks as a snapshot. Same read
 * path as the wait tools (octokit), but it never polls — pending checks come
 * back as-is.
 */
export async function prStatus(gh: GhClient, call: ToolCall<PrStatusParams>) {
  const { params, ctx, signal } = call;
  const { number, repo } = params;
  const pullNumber = toPositiveId(number, "number");
  const {
    fullName: effectiveRepo,
    owner,
    name,
  } = await resolveRepoTarget(repo, signal, ctx.cwd, params);

  const pollSignal = signal ?? new AbortController().signal;
  const headSha = await gh.checks.pullHead(owner, name, pullNumber, pollSignal);
  const [statuses, checkRuns, suites] = await Promise.all([
    gh.checks.statuses(owner, name, headSha, pollSignal),
    gh.checks.checkRuns(owner, name, headSha, pollSignal),
    gh.checks.suites(owner, name, headSha, pollSignal),
  ]);
  // The trigger event of a check run and the name of a suite only exist on the
  // commit's workflow runs.
  const workflowRuns =
    suites.length > 0 || checkRuns.some((run) => run.runId !== null)
      ? await gh.checks.workflowRuns(owner, name, headSha, pollSignal)
      : [];
  const checks = mergeChecks(statuses, checkRuns, suites, workflowRuns).map((check) => ({
    name: check.name,
    bucket: check.bucket,
    event: check.event,
    run_id: check.runId,
    job_id: check.jobId,
    suite_id: check.suiteId,
    url: check.link,
  }));

  return structuredResult(prStatusSchema, {
    pr: pullNumber,
    repo: effectiveRepo,
    head_sha: headSha,
    checks,
  });
}

export function addReadPrStatusTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-pr-status",
    label: "GitHub PR Status",
    description:
      "Get the current checks of a pull request's head commit. Each check's `bucket` is pass / fail / pending / skipped / action_required; `action_required` means the workflow is waiting for a maintainer's approval (a fork PR's first run) and has created no check run yet, so it is listed from its check suite and named after its workflow run. Actions checks carry the `run_id` and `job_id` behind them (null for other CI), which is what read-github-ci-logs and get-github-workflow-jobs take; `suite_id` groups the checks of one suite. Returns the snapshot immediately without waiting — use wait-github-pr-checks to block until the checks finish.",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
    }),
    structuredSchema: prStatusSchema,
    async execute(_id, params, signal, ctx) {
      return prStatus(gh, { params, ctx, signal });
    },
  });
}
