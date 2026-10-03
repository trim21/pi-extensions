import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, toStructuredJsonResult, withPendant } from "../base.js";
import { issueViewSchema } from "../schemas.js";

export function addReadIssueTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-issue",
      label: "GitHub Issue",
      description: "Get details of a GitHub issue by number.",
      promptSnippet: "Read a GitHub issue",
      parameters: Type.Object({
        number: Type.Union([Type.Number(), Type.String()], { description: "Issue number" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
      }),
      structuredSchema: issueViewSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { number, repo } = params;
        const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
        const data = await gh.reads.issue(owner, name, Number(number), signal);
        const result = toStructuredJsonResult(
          JSON.stringify(data, null, 2),
          params,
          issueViewSchema,
        );
        return withPendant(result, params, "number");
      },
    }),
  );
}
