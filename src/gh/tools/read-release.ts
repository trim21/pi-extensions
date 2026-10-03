import { Type } from "typebox";

import { parseWithSchema } from "../../lib/parse-with-schema.js";
import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  ghExec,
  repoArgs,
  subtitlePendant,
  toToolResult,
  withStructuredResult,
} from "../base.js";
import { renderReleaseView } from "../render.js";
import { ghReleaseViewPayloadSchema, ghReleaseViewSchema } from "../schemas.js";

/** 我们向 gh 要的 release 字段，与渲染和载荷一一对应。 */
const RELEASE_FIELDS = [
  "tagName",
  "name",
  "body",
  "url",
  "isDraft",
  "isPrerelease",
  "createdAt",
  "publishedAt",
  "targetCommitish",
  "author",
  "assets",
].join(",");

export function addReadReleaseTool(_gh: GhClient, bus: ToolBus) {
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
        const stdout = await ghExec(
          ["release", "view", tag, ...repoArgs(repo), "--json", RELEASE_FIELDS],
          { cwd: ctx.cwd, signal, input: params },
        );
        const view = parseWithSchema(ghReleaseViewSchema, JSON.parse(stdout));
        const text = renderReleaseView(view);
        const result = toToolResult(text, params);
        result.details.pendant = subtitlePendant(params, "tag");
        return withStructuredResult(result, { text, release: view });
      },
    }),
  );
}
