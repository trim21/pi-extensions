import { Type } from "typebox";

import type { ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, ghExec, repoArgs, subtitlePendant, toToolResult } from "../base.js";

export function addReadReleaseTool(_gh: GhClient, bus: ToolBus) {
  bus.register({
    name: "read-github-release",
    label: "GitHub Release",
    description: "Get details of a specific GitHub release by tag.",
    promptSnippet: "Read a GitHub release",
    parameters: Type.Object({
      tag: Type.String({ description: "Release tag name" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { tag, repo } = params;
      const result = toToolResult(
        await ghExec(["release", "view", tag, ...repoArgs(repo)], {
          cwd: ctx.cwd,
          signal,
          input: params,
        }),
        params,
      );
      result.details.pendant = subtitlePendant(params, "tag");
      return result;
    },
  });
}
