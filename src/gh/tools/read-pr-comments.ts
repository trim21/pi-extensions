import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, toStructuredJsonResult, withPendant } from "../base.js";
import { prCommentsSchema } from "../schemas.js";

export function addReadPrCommentsTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-pr-comments",
      label: "GitHub PR Comments",
      description:
        "Get review comments on a GitHub pull request. Set reviews=true for inline code review comments with diff_hunk.",
      promptSnippet: "Read GitHub PR comments",
      parameters: Type.Object({
        number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
        reviews: Type.Optional(
          Type.Boolean({
            description:
              "If true, returns inline code review comments (with diff_hunk, path, line) via API. Default: false (returns issue comments).",
          }),
        ),
      }),
      structuredSchema: prCommentsSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { number, repo, reviews } = params;
        const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
        const pullNumber = Number(number);

        // reviews=true 给行内评审评论 + 评审摘要；缺省给 PR 上的普通（issue）评论
        const payload = reviews
          ? {
              reviews: await gh.reads.pullReviews(owner, name, pullNumber, signal),
              comments: await gh.reads.pullReviewComments(owner, name, pullNumber, signal),
            }
          : {
              comments: await gh.reads.issueComments(owner, name, pullNumber, signal),
            };

        const result = toStructuredJsonResult(
          JSON.stringify(payload, null, 2),
          params,
          prCommentsSchema,
        );
        return withPendant(result, params, "number");
      },
    }),
  );
}
