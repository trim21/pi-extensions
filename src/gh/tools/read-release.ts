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
import { renderReleaseView } from "../render.js";
import { ghReleaseViewPayloadSchema, ghReleaseViewSchema } from "../schemas.js";

export function addReadReleaseTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-release",
      label: "GitHub Release",
      description:
        "Get details of a specific GitHub release by tag: metadata, asset list and release notes.",
      promptSnippet: "Read a GitHub release",
      parameters: Type.Object({
        tag: Type.String({ description: "Release tag name" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      }),
      structuredSchema: ghReleaseViewPayloadSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { tag, repo } = params;
        const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
        const data = await gh.reads.release(owner, name, tag, signal);
        const view = parseWithSchema(ghReleaseViewSchema, data);
        const text = renderReleaseView(view);
        const result = toToolResult(text, params);
        return withStructuredResult(withPendant(result, params, "tag"), { text, release: view });
      },
    }),
  );
}
