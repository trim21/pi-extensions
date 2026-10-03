import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepo,
  splitRepo,
  subtitlePendant,
  toStructuredJsonResult,
} from "../base.js";
import { issueCommentsSchema } from "../schemas.js";

export function addReadIssueCommentsTool(gh: GhClient, bus: ToolBus) {
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
        const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
        const { owner, repo: repoName } = splitRepo(effectiveRepo);
        const comments = await gh.reads.issueComments(owner, repoName, Number(number), signal);
        const result = toStructuredJsonResult(
          JSON.stringify({ comments }, null, 2),
          params,
          issueCommentsSchema,
        );
        result.details.pendant = subtitlePendant(params, "number");
        return result;
      },
    }),
  );
}
