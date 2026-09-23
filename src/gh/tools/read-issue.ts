import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type GhClient, ghExec, repoArgs, subtitlePendant, toToolResultJson } from "../base.js";

export function addReadIssueTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "read-github-issue",
    label: "GitHub Issue",
    description: "Get details of a GitHub issue by number.",
    promptSnippet: "Read a GitHub issue",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "Issue number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const result = toToolResultJson(
        await ghExec(
          [
            "issue",
            "view",
            String(number),
            ...repoArgs(repo),
            "--json",
            "title,state,body,author,createdAt,updatedAt,closedAt,url,labels,assignees,comments,milestone,number",
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
