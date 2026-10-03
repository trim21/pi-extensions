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
import { renderReleaseList } from "../render.js";
import { ghReleaseListPayloadSchema, ghReleaseSummarySchema } from "../schemas.js";

export function addListReleasesTool(gh: GhClient, bus: ToolBus) {
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
        const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
        const { owner, repo: repoName } = splitRepo(effectiveRepo);
        const items = await gh.reads.listReleases(owner, repoName, limit, signal);
        const releases = parseWithSchema(Type.Array(ghReleaseSummarySchema), items);
        // REST 没有 isLatest：按列表顺序取第一个非 draft / prerelease 的条目
        const latestIndex = releases.findIndex(
          (release) => release.draft !== true && release.prerelease !== true,
        );
        const text = renderReleaseList(
          releases.map((release, index) => ({ ...release, latest: index === latestIndex })),
        );
        const result = toToolResult(text, params);
        result.details.pendant = subtitlePendant(params);
        return withStructuredResult(result, { text, releases });
      },
    }),
  );
}
