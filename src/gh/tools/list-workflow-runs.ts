import { z } from "zod";

import { runListParameters } from "../../lib/github-params.js";
import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { ghRunListPayloadSchema, ghRunSummarySchema } from "../schemas.js";

export function addListWorkflowRunsTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "list-github-workflow-runs",
    label: "GitHub Workflow Runs",
    description: "List GitHub Actions workflow runs.",
    parameters: runListParameters,
    structuredSchema: ghRunListPayloadSchema,
    async execute(_id, params, signal, ctx) {
      const { limit, status, workflow } = params;
      const { owner, name } = await resolveRepoTarget(params.repo, signal, ctx.cwd, params);
      const items = await gh.reads.listRuns(owner, name, { workflow, status, limit }, signal);
      const runs = z.array(ghRunSummarySchema).parse(items);
      return structuredResult(ghRunListPayloadSchema, { runs });
    },
  });
}
