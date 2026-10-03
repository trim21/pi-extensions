import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  ghExec,
  repoArgs,
  subtitlePendant,
  toStructuredJsonResult,
} from "../base.js";
import { issueCommentsSchema } from "../schemas.js";

export function addReadIssueCommentsTool(_gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-issue-comments",
      label: "GitHub Issue Comments",
      description: "Get comments on a GitHub issue.",
      promptSnippet: "Read GitHub issue comments",
      parameters: Type.Object({
        number: Type.Union([Type.Number(), Type.String()], { description: "Issue number" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      }),
      structuredSchema: issueCommentsSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { number, repo } = params;
        const out = await ghExec(
          ["issue", "view", String(number), ...repoArgs(repo), "--json", "comments"],
          { cwd: ctx.cwd, signal, input: params },
        );
        const result = toStructuredJsonResult(out, params, issueCommentsSchema);
        result.details.pendant = subtitlePendant(params, "number");
        return result;
      },
    }),
  );
}
