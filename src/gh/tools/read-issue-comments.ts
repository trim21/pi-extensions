import { Type } from "typebox";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { issueCommentsSchema } from "../schemas.js";

export function addReadIssueCommentsTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-issue-comments",
    label: "GitHub Issue Comments",
    description: "Get comments on a GitHub issue.",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "Issue number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    structuredSchema: issueCommentsSchema,
    async execute(_id, params, signal, ctx) {
      const { number, repo } = params;
      const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
      const comments = await gh.reads.issueComments(owner, name, Number(number), signal);
      return structuredResult(issueCommentsSchema, { comments });
    },
  });
}
