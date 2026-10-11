import { Type } from "typebox";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { ghRepoPayloadSchema } from "../schemas.js";

export function addReadRepoTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-repo",
    label: "GitHub Repo",
    description: "Get repository information.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    structuredSchema: ghRepoPayloadSchema,
    async execute(_id, params, signal, ctx) {
      const { owner, name } = await resolveRepoTarget(params.repo, signal, ctx.cwd, params);
      const data = await gh.reads.repository(owner, name, signal);
      return structuredResult(ghRepoPayloadSchema, { repo: data });
    },
  });
}
