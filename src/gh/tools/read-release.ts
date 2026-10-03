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
        const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
        const { owner, repo: repoName } = splitRepo(effectiveRepo);
        const data = await gh.reads.release(owner, repoName, tag, signal);
        const view = parseWithSchema(ghReleaseViewSchema, data);
        const text = renderReleaseView(view);
        const result = toToolResult(text, params);
        result.details.pendant = subtitlePendant(params, "tag");
        return withStructuredResult(result, { text, release: view });
      },
    }),
  );
}
