import { z } from "zod";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { issueViewSchema } from "../schemas.js";

export function addReadIssueTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-issue",
    label: "GitHub Issue",
    description: "Get details of a GitHub issue by number.",
    parameters: z.object({
      number: z.union([z.number(), z.string()]).describe("Issue number"),
      repo: z.string().describe("OWNER/REPO (defaults to current repo)").optional(),
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
