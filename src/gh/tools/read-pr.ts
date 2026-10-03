import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  ghExec,
  repoArgs,
  subtitlePendant,
  toStructuredJsonResult,
} from "../base.js";
import { prViewSchema } from "../schemas.js";

export function addReadPrTool(_gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-pr",
      label: "GitHub PR",
      description: "Get details of a GitHub pull request by number.",
      promptSnippet: "Read a GitHub PR",
      parameters: Type.Object({
        number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      }),
      structuredSchema: prViewSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { number, repo } = params;
        const out = await ghExec(
          [
            "pr",
            "view",
            String(number),
            ...repoArgs(repo),
            "--json",
            "title,state,body,author,createdAt,updatedAt,mergedAt,mergedBy,headRefName,baseRefName,url,additions,deletions,changedFiles,labels,assignees,reviewRequests,reviews,comments,number",
          ],
          { cwd: ctx.cwd, signal, input: params },
        );
        const result = toStructuredJsonResult(out, params, prViewSchema);
        result.details.pendant = subtitlePendant(params, "number");
        return result;
      },
    }),
  );
}
