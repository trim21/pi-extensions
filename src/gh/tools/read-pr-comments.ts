import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepo,
  splitRepo,
  subtitlePendant,
  toStructuredJsonResult,
} from "../base.js";
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
        const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
        const { owner, repo: repoName } = splitRepo(effectiveRepo);
        const pullNumber = Number(number);

        // reviews=true 给行内评审评论 + 评审摘要；缺省给 PR 上的普通（issue）评论
        const payload = reviews
          ? {
              reviews: await gh.reads.pullReviews(owner, repoName, pullNumber, signal),
              comments: await gh.reads.pullReviewComments(owner, repoName, pullNumber, signal),
            }
          : {
              comments: await gh.reads.issueComments(owner, repoName, pullNumber, signal),
            };

        const result = toStructuredJsonResult(
          JSON.stringify(payload, null, 2),
          params,
          prCommentsSchema,
        );
        result.details.pendant = subtitlePendant(params, "number");
        return result;
      },
    }),
  );
}
