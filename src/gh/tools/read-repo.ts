import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type GhClient, ghExec, subtitlePendant, toToolResult } from "../base.js";

export function addReadRepoTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "read-github-repo",
    label: "GitHub Repo",
    description: "Get repository information.",
    promptSnippet: "Read GitHub repo info",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { repo } = params;
      const args = ["repo", "view"];
      if (repo) args.push(repo);
      const result = toToolResult(
        await ghExec(args, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
      result.details.pendant = subtitlePendant(params);
      return result;
    },
  });
}
