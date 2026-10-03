import { Type } from "typebox";

import { parseWithSchema } from "../../lib/parse-with-schema.js";
import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepo,
  splitRepo,
  subtitlePendant,
  toToolResult,
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
        const { repo, limit, status, workflow } = params;
        const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
        const { owner, repo: repoName } = splitRepo(effectiveRepo);
        const items = await gh.reads.listRuns(owner, repoName, { workflow, status, limit }, signal);
        const runs = parseWithSchema(Type.Array(ghRunSummarySchema), items);
        const text = renderRunList(runs);
        const result = toToolResult(text, params);
        result.details.pendant = subtitlePendant(params);
        return withStructuredResult(result, { text, runs });
      },
    }),
  );
}
