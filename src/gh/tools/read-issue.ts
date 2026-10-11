import { Type } from "typebox";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { issueViewSchema } from "../schemas.js";

export function addReadIssueTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-issue",
    label: "GitHub Issue",
    description: "Get details of a GitHub issue by number.",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "Issue number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
    }),
    structuredSchema: issueViewSchema,
    async execute(_id, params, signal, ctx) {
      const { number, repo } = params;
      const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
      return structuredResult(
        issueViewSchema,
        await gh.reads.issue(owner, name, Number(number), signal),
      );
    },
  });
}
