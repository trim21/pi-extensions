import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  ghApiList,
  type GhClient,
  ghExec,
  repoArgs,
  resolveRepo,
  subtitlePendant,
  truncate,
} from "../base.js";

export function addReadPrCommentsTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo, reviews } = params;
      let out: string;
      if (reviews) {
        const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);

        const [reviewComments, reviewSummaries] = await Promise.all([
          ghApiList(`/repos/${effectiveRepo}/pulls/${String(number)}/comments`, {
            cwd: ctx.cwd,
            signal,
            input: params,
          }),
          ghApiList(`/repos/${effectiveRepo}/pulls/${String(number)}/reviews`, {
            cwd: ctx.cwd,
            signal,
            input: params,
          }),
        ]);

        out = JSON.stringify(
          {
            reviews: reviewSummaries,
            comments: reviewComments,
          },
          null,
          2,
        );
      } else {
        out = await ghExec(
          ["pr", "view", String(number), ...repoArgs(repo), "--json", "comments"],
          {
            cwd: ctx.cwd,
            signal,
            input: params,
          },
        );
      }
      const { text, truncated } = truncate(out);
      const pendant = subtitlePendant(params, "number");
      return {
        content: [{ type: "text", text }],
        details: { input: params, truncated, ...(pendant && { pendant }) },
      };
    },
  });
}
