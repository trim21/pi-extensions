import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepoTarget,
  type StructuredResultOf,
  type ToolCall,
  toPositiveId,
  toStructuredJsonResult,
  withPendant,
} from "../base.js";
import { workflowJobsSchema } from "../schemas.js";

interface RunIdParams {
  run_id: number | string;
  repo?: string;
}

/** The toolcall handler behind `get-github-workflow-jobs`: every job of a run, all pages. */
async function workflowJobs(
  gh: GhClient,
  call: ToolCall<RunIdParams>,
): Promise<StructuredResultOf<typeof workflowJobsSchema>> {
  const { params, ctx, signal } = call;
  const runId = toPositiveId(params.run_id, "run_id");
  const { owner, name } = await resolveRepoTarget(params.repo, signal, ctx.cwd, params);

  const jobs = await gh.checks.runJobs(owner, name, runId, signal);
  const result = toStructuredJsonResult(
    JSON.stringify({ total_count: jobs.length, jobs }),
    params,
    workflowJobsSchema,
  );
  return withPendant(result, params, "run_id");
}

export function addGetWorkflowJobsTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "get-github-workflow-jobs",
      label: "GitHub Workflow Jobs",
      description:
        "Get every job of a workflow run as JSON {total_count, jobs:[{id, run_id, run_url, name, status, conclusion, html_url, steps:[{name, number, status, conclusion, started_at}]}]}. Paginated server-side, so runs with more than 30 jobs return all of them. Use the `id` with read-github-ci-logs after read-github-pr-status / wait-github-commit-checks did not already give you a job id.",
      promptSnippet: "Get GitHub workflow run jobs",
      parameters: Type.Object({
        run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      }),
      structuredSchema: workflowJobsSchema,
      async execute(_id, params, signal, onUpdate, ctx) {
        return workflowJobs(gh, { params, ctx, signal, onUpdate });
      },
    }),
  );
}
