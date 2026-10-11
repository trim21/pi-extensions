import { Type } from "typebox";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { ghReleaseViewPayloadSchema } from "../schemas.js";

export function addReadReleaseTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-release",
    label: "GitHub Release",
    description:
      "Get details of a specific GitHub release by tag: metadata, asset list and release notes.",
    parameters: Type.Object({
      tag: Type.String({ description: "Release tag name" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    structuredSchema: ghReleaseViewPayloadSchema,
    async execute(_id, params, signal, ctx) {
      const { tag, repo } = params;
      const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
      const data = await gh.reads.release(owner, name, tag, signal);
      return structuredResult(ghReleaseViewPayloadSchema, { release: data });
    },
  });
}
