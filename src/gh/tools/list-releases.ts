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
import { renderReleaseList } from "../render.js";
import { ghReleaseListPayloadSchema, ghReleaseSummarySchema } from "../schemas.js";

/** 我们向 gh 要的 release 字段，与渲染和载荷一一对应。 */
const RELEASE_FIELDS = "tagName,name,isLatest,isPrerelease,isDraft,publishedAt,createdAt";

export function addListReleasesTool(_gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "list-github-releases",
      label: "GitHub Releases List",
      description:
        "List GitHub releases. Each row is: tag, flags (latest/prerelease/draft), published date, name.",
      promptSnippet: "List GitHub releases",
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
      }),
      structuredSchema: ghReleaseListPayloadSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { repo, limit } = params;
        const args = ["release", "list", ...repoArgs(repo), "--json", RELEASE_FIELDS];
        if (limit) {
          args.push("--limit", String(limit));
        }
        const stdout = await ghExec(args, { cwd: ctx.cwd, signal, input: params });
        const releases = parseWithSchema(Type.Array(ghReleaseSummarySchema), JSON.parse(stdout));
        const text = renderReleaseList(releases);
        const result = toToolResult(text, params);
        result.details.pendant = subtitlePendant(params);
        return withStructuredResult(result, { text, releases });
      },
    }),
  );
}
