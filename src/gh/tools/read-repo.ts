import { z } from "zod";

import { type ToolBus } from "../../lib/tool-bus.js";
import { zodStructuredResult } from "../../lib/zod-tool.js";
import { type GhClient, resolveRepoTarget } from "../base.js";
import { ghRepoPayloadSchema } from "../schemas.js";

export function addReadRepoTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-repo",
    label: "GitHub Repo",
    description: "Get repository information.",
    parameters: z.object({
      repo: z.string().optional().describe("OWNER/REPO"),
    }),
    structuredSchema: ghRepoPayloadSchema,
    async execute(_id, params, signal, ctx) {
      const { owner, name } = await resolveRepoTarget(params.repo, signal, ctx.cwd, params);
      const data = await gh.reads.repository(owner, name, signal);
      return zodStructuredResult(ghRepoPayloadSchema, { repo: data });
    },
  });
}
