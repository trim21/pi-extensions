import { Type } from "typebox";

import { GH_RELEASES_DEFAULT_LIMIT } from "../../lib/github-reads.js";
import { parseWithSchema } from "../../lib/parse-with-schema.js";
import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { ghReleaseListPayloadSchema, ghReleaseSummarySchema } from "../schemas.js";

export function addListReleasesTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "list-github-releases",
    label: "GitHub Releases List",
    description: "List GitHub releases.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      limit: Type.Optional(
        Type.Number({ default: GH_RELEASES_DEFAULT_LIMIT, description: "Max results" }),
      ),
    }),
    structuredSchema: ghReleaseListPayloadSchema,
    async execute(_id, params, signal, ctx) {
      const { limit } = params;
      const { owner, name } = await resolveRepoTarget(params.repo, signal, ctx.cwd, params);
      const items = await gh.reads.listReleases(owner, name, limit, signal);
      const releases = parseWithSchema(Type.Array(ghReleaseSummarySchema), items);
      return structuredResult(ghReleaseListPayloadSchema, { releases });
    },
  });
}
