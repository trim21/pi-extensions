import { Type } from "typebox";

import { type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepoTarget,
  structuredResult,
  type ToolCall,
  toPositiveId,
} from "../base.js";
import { workflowJobsSchema } from "../schemas.js";

interface RunIdParams {
  run_id: number | string;
  repo?: string;
}

/** The toolcall handler behind `get-github-workflow-jobs`: every job of a run, all pages. */
async function workflowJobs(gh: GhClient, call: ToolCall<RunIdParams>) {
  const { params, ctx, signal } = call;
  const runId = toPositiveId(params.run_id, "run_id");
  const { owner, name } = await resolveRepoTarget(params.repo, signal, ctx.cwd, params);
  const jobs = await gh.checks.runJobs(owner, name, runId, signal);
  return structuredResult(workflowJobsSchema, { total_count: jobs.length, jobs });
}

export function addGetWorkflowJobsTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "get-github-workflow-jobs",
    label: "GitHub Workflow Jobs",
    description:
      "Get every job of a workflow run. Paginated server-side, so runs with more than 30 jobs return all of them. Use the `id` with read-github-ci-logs after read-github-pr-status / wait-github-commit-checks did not already give you a job id.",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    structuredSchema: workflowJobsSchema,
    async execute(_id, params, signal, ctx) {
      return workflowJobs(gh, { params, ctx, signal });
    },
  });
}
