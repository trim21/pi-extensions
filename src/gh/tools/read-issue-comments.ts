import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type GhClient, ghExec, repoArgs, subtitlePendant, toToolResult } from "../base.js";

export function addReadIssueCommentsTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "read-github-issue-comments",
    label: "GitHub Issue Comments",
    description: "Get comments on a GitHub issue.",
    promptSnippet: "Read GitHub issue comments",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "Issue number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const result = toToolResult(
        await ghExec(["issue", "view", String(number), ...repoArgs(repo), "--json", "comments"], {
          cwd: ctx.cwd,
          signal,
          input: params,
        }),
        params,
      );
      result.details.pendant = subtitlePendant(params, "number");
      return result;
    },
  });
}
