import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type GhClient,
  mergeChecks,
  resolveRepo,
  splitRepo,
  subtitlePendant,
  type ToolCall,
  type ToolResult,
  toPositiveId,
} from "../base.js";

interface PrStatusParams {
  number: number | string;
  repo?: string;
}

/**
 * `read-github-pr-status`: the PR head commit's checks as a snapshot. Same read
 * path as the wait tools (octokit), but it never polls — pending checks come
 * back as-is.
 */
export async function prStatus(gh: GhClient, call: ToolCall<PrStatusParams>): Promise<ToolResult> {
  const { params, ctx, signal } = call;
  const { number, repo } = params;
  const pullNumber = toPositiveId(number, "number");
  const pendant = subtitlePendant(params, "number");
  const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
  const { owner, repo: name } = splitRepo(effectiveRepo);

  const pollSignal = signal ?? new AbortController().signal;
  const headSha = await gh.checks.pullHead(owner, name, pullNumber, pollSignal);
  const [statuses, checkRuns] = await Promise.all([
    gh.checks.statuses(owner, name, headSha, pollSignal),
    gh.checks.checkRuns(owner, name, headSha, pollSignal),
  ]);
  const checks = mergeChecks(statuses, checkRuns).map((check) => ({
    name: check.name,
    bucket: check.bucket,
    event: check.event,
    run_id: check.runId,
    job_id: check.jobId,
    url: check.link,
  }));

  const payload = { pr: pullNumber, repo: effectiveRepo, head_sha: headSha, checks };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: { ...payload, input: params, ...(pendant && { pendant }) },
  };
}

export function addReadPrStatusTool(gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "read-github-pr-status",
    label: "GitHub PR Status",
    description:
      "Get the current checks of a pull request's head commit as JSON {pr, repo, head_sha, checks:[{name, bucket, event, run_id, job_id, url}]}. `bucket` is pass / fail / pending / skipped; Actions checks carry the `run_id` and `job_id` behind them (null for other CI), which is what read-github-ci-logs and get-github-workflow-jobs take. Returns the snapshot immediately without waiting — use wait-github-pr-checks to block until the checks finish.",
    promptSnippet: "Read GitHub PR status checks",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return prStatus(gh, { params, ctx, signal, onUpdate });
    },
  });
}
