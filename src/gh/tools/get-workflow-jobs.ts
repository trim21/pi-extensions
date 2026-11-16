import { z } from "zod";

import { type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepoTarget,
  structuredResult,
  type ToolCall,
  toPositiveId,
} from "../base.js";
import { workflowJobsSchema } from "../schemas.js";

const workflowJobsParameters = z.object({
  run_id: z.union([z.number(), z.string()]).describe("Workflow run ID"),
  repo: z.string().describe("OWNER/REPO").optional(),
});

/** 入参类型由参数 schema 推断，schema 是唯一来源。 */
type RunIdParams = z.infer<typeof workflowJobsParameters>;

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
    parameters: workflowJobsParameters,
    structuredSchema: workflowJobsSchema,
    async execute(_id, params, signal, ctx) {
      return workflowJobs(gh, { params, ctx, signal });
    },
  });
}
