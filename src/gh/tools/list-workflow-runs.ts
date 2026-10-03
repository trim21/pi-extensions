import { Type } from "typebox";

import { parseWithSchema } from "../../lib/parse-with-schema.js";
import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepoTarget,
  toToolResult,
  withPendant,
  withStructuredResult,
} from "../base.js";
import { renderRunList } from "../render.js";
import { ghRunListPayloadSchema, ghRunSummarySchema } from "../schemas.js";

export function addListWorkflowRunsTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "list-github-workflow-runs",
      label: "GitHub Workflow Runs",
      description:
        "List GitHub Actions workflow runs. Each row is: id, status, conclusion, workflow, branch, event, created date, url.",
      promptSnippet: "List GitHub workflow runs",
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
        status: Type.Optional(
          Type.String({ description: "Filter by status: success, failure, cancelled, etc." }),
        ),
        workflow: Type.Optional(Type.String({ description: "Filter by workflow name or file" })),
      }),
      structuredSchema: ghRunListPayloadSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { limit, status, workflow } = params;
        const { owner, name } = await resolveRepoTarget(params.repo, signal, ctx.cwd, params);
        const items = await gh.reads.listRuns(owner, name, { workflow, status, limit }, signal);
        const runs = parseWithSchema(Type.Array(ghRunSummarySchema), items);
        const text = renderRunList(runs);
        const result = toToolResult(text, params);
        return withStructuredResult(withPendant(result, params), { text, runs });
      },
    }),
  );
}
