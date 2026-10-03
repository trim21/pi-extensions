import { Type } from "typebox";

import { parseWithSchema } from "../../lib/parse-with-schema.js";
import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepo,
  splitRepo,
  subtitlePendant,
  toToolResult,
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
        const { repo } = params;
        const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
        const { owner, repo: repoName } = splitRepo(effectiveRepo);
        const data = await gh.reads.repository(owner, repoName, signal);
        const view = parseWithSchema(ghRepoViewSchema, data);
        const text = renderRepoView(view);
        const result = toToolResult(text, params);
        result.details.pendant = subtitlePendant(params);
        return withStructuredResult(result, { text, repo: view });
      },
    }),
  );
}
