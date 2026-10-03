import { Type } from "typebox";

import { parseWithSchema } from "../../lib/parse-with-schema.js";
import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepoTarget,
  toToolResult,
  withPendant,
  withStructuredResult,
} from "../base.js";
import { renderRepoView } from "../render.js";
import { ghRepoPayloadSchema, ghRepoViewSchema } from "../schemas.js";

export function addReadRepoTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-repo",
      label: "GitHub Repo",
      description: "Get repository information.",
      promptSnippet: "Read GitHub repo info",
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      }),
      structuredSchema: ghRepoPayloadSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { owner, name } = await resolveRepoTarget(params.repo, signal, ctx.cwd, params);
        const data = await gh.reads.repository(owner, name, signal);
        const view = parseWithSchema(ghRepoViewSchema, data);
        const text = renderRepoView(view);
        const result = toToolResult(text, params);
        return withStructuredResult(withPendant(result, params), { text, repo: view });
      },
    }),
  );
}
