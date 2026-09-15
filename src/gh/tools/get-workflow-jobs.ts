import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type GhClient,
  resolveRepo,
  splitRepo,
  subtitlePendant,
  type ToolCall,
  type ToolResult,
  toPositiveId,
  toToolResult,
} from "../base.js";

interface RunIdParams {
  run_id: number | string;
  repo?: string;
}

/** The toolcall handler behind `get-github-workflow-jobs`: every job of a run, all pages. */
async function workflowJobs(gh: GhClient, call: ToolCall<RunIdParams>): Promise<ToolResult> {
  const { params, ctx, signal } = call;
  const runId = toPositiveId(params.run_id, "run_id");
  const effectiveRepo = await resolveRepo(params.repo, signal, ctx.cwd, params);
  const { owner, repo: name } = splitRepo(effectiveRepo);

  const jobs = await gh.checks.runJobs(owner, name, runId, signal);
  const result = toToolResult(JSON.stringify({ total_count: jobs.length, jobs }), params);
  result.details.pendant = subtitlePendant(params, "run_id");
  return result;
}

export function addGetWorkflowJobsTool(gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "get-github-workflow-jobs",
    label: "GitHub Workflow Jobs",
    description:
      "Get every job of a workflow run as JSON {total_count, jobs:[{id, run_id, run_url, name, status, conclusion, html_url, steps:[{name, number, status, conclusion, started_at}]}]}. Paginated server-side, so runs with more than 30 jobs return all of them. Use the `id` with read-github-ci-logs after read-github-pr-status / wait-github-commit-checks did not already give you a job id.",
    promptSnippet: "Get GitHub workflow run jobs",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return workflowJobs(gh, { params, ctx, signal, onUpdate });
    },
  });
}
