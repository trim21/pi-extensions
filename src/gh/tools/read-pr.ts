import { Type } from "typebox";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { prViewSchema } from "../schemas.js";

export function addReadPrTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-pr",
    label: "GitHub PR",
    description: "Get details of a GitHub pull request by number.",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    structuredSchema: prViewSchema,
    async execute(_id, params, signal, ctx) {
      const { number, repo } = params;
      const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
      return structuredResult(
        prViewSchema,
        await gh.reads.pull(owner, name, Number(number), signal),
      );
    },
  });
}
