import { Type } from "typebox";

import { parseWithSchema } from "../../lib/parse-with-schema.js";
import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  ghExec,
  repoArgs,
  subtitlePendant,
  toToolResult,
  withStructuredResult,
} from "../base.js";
import { renderRunList } from "../render.js";
import { ghRunListPayloadSchema, ghRunSummarySchema } from "../schemas.js";

/** 我们向 gh 要的运行字段，与渲染和载荷一一对应。 */
const RUN_FIELDS =
  "databaseId,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url";

export function addListWorkflowRunsTool(_gh: GhClient, bus: ToolBus) {
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
        const args = ["run", "list", ...repoArgs(repo), "--json", RUN_FIELDS];
        if (limit) {
          args.push("--limit", String(limit));
        }
        if (status) {
          args.push("--status", status);
        }
        if (workflow) {
          args.push("--workflow", workflow);
        }
        const stdout = await ghExec(args, { cwd: ctx.cwd, signal, input: params });
        const runs = parseWithSchema(Type.Array(ghRunSummarySchema), JSON.parse(stdout));
        const text = renderRunList(runs);
        const result = toToolResult(text, params);
        result.details.pendant = subtitlePendant(params);
        return withStructuredResult(result, { text, runs });
      },
    }),
  );
}
