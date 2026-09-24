import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type GhClient, ghExec, repoArgs, subtitlePendant, toToolResult } from "../base.js";

export function addListReleasesTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "list-github-releases",
    label: "GitHub Releases List",
    description: "List GitHub releases.",
    promptSnippet: "List GitHub releases",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { repo, limit } = params;
      const args = ["release", "list", ...repoArgs(repo)];
      if (limit) {
        args.push("--limit", String(limit));
      }
      const result = toToolResult(
        await ghExec(args, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
      result.details.pendant = subtitlePendant(params);
      return result;
    },
  });
}
