import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type GhClient, ghExec, repoArgs, subtitlePendant, toToolResult } from "../base.js";

export function addReadPrDiffTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "read-github-pr-diff",
    label: "GitHub PR Diff",
    description: "Get the diff of a GitHub pull request.",
    promptSnippet: "Read a GitHub PR diff",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { number, repo } = params;
      const args = ["pr", "diff", String(number), ...repoArgs(repo)];
      const result = toToolResult(
        await ghExec(args, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
      result.details.pendant = subtitlePendant(params, "number");
      return result;
    },
  });
}
