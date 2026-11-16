import { z } from "zod";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { issueCommentsSchema } from "../schemas.js";

export function addReadIssueCommentsTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-issue-comments",
    label: "GitHub Issue Comments",
    description: "Get comments on a GitHub issue.",
    parameters: z.object({
      number: z.union([z.number(), z.string()]).describe("Issue number"),
      repo: z.string().describe("OWNER/REPO").optional(),
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
