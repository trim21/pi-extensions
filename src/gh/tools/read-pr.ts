import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type GhClient, ghExec, repoArgs, subtitlePendant, toToolResultJson } from "../base.js";

export function addReadPrTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "read-github-pr",
    label: "GitHub PR",
    description: "Get details of a GitHub pull request by number.",
    promptSnippet: "Read a GitHub PR",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const result = toToolResultJson(
        await ghExec(
          [
            "pr",
            "view",
            String(number),
            ...repoArgs(repo),
            "--json",
            "title,state,body,author,createdAt,updatedAt,mergedAt,mergedBy,headRefName,baseRefName,url,additions,deletions,changedFiles,labels,assignees,reviewRequests,reviews,comments,number",
          ],
          { cwd: ctx.cwd, signal, input: params },
        ),
        params,
      );
      result.details.pendant = subtitlePendant(params, "number");
      return result;
    },
  });
}
