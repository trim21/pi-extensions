import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, toStructuredJsonResult, withPendant } from "../base.js";
import { prViewSchema } from "../schemas.js";

export function addReadPrTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-pr",
      label: "GitHub PR",
      description: "Get details of a GitHub pull request by number.",
      promptSnippet: "Read a GitHub PR",
      parameters: Type.Object({
        number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      }),
      structuredSchema: prViewSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { number, repo } = params;
        const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
        const data = await gh.reads.pull(owner, name, Number(number), signal);
        const result = toStructuredJsonResult(JSON.stringify(data, null, 2), params, prViewSchema);
        return withPendant(result, params, "number");
      },
    }),
  );
}
