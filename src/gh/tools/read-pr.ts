import { z } from "zod";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { prViewSchema } from "../schemas.js";

export function addReadPrTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-pr",
    label: "GitHub PR",
    description: "Get details of a GitHub pull request by number.",
    parameters: z.object({
      number: z.union([z.number(), z.string()]).describe("PR number"),
      repo: z.string().describe("OWNER/REPO").optional(),
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
