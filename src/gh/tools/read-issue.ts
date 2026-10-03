import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  ghExec,
  repoArgs,
  subtitlePendant,
  toStructuredJsonResult,
} from "../base.js";
import { issueViewSchema } from "../schemas.js";

export function addReadIssueTool(_gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-issue",
      label: "GitHub Issue",
      description: "Get details of a GitHub issue by number.",
      promptSnippet: "Read a GitHub issue",
      parameters: Type.Object({
        number: Type.Union([Type.Number(), Type.String()], { description: "Issue number" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
      }),
      structuredSchema: issueViewSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { number, repo } = params;
        const out = await ghExec(
          [
            "issue",
            "view",
            String(number),
            ...repoArgs(repo),
            "--json",
            "title,state,body,author,createdAt,updatedAt,closedAt,url,labels,assignees,comments,milestone,number",
          ],
          { cwd: ctx.cwd, signal, input: params },
        );
        const result = toStructuredJsonResult(out, params, issueViewSchema);
        result.details.pendant = subtitlePendant(params, "number");
        return result;
      },
    }),
  );
}
