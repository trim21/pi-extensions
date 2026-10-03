import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepoTarget,
  toToolResult,
  withPendant,
  withStructuredResult,
} from "../base.js";
import { parseDiffStats } from "../render.js";
import { ghDiffPayloadSchema } from "../schemas.js";

export function addReadPrDiffTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-pr-diff",
      label: "GitHub PR Diff",
      description: "Get the diff of a GitHub pull request.",
      promptSnippet: "Read a GitHub PR diff",
      parameters: Type.Object({
        number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      }),
      structuredSchema: ghDiffPayloadSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { number, repo } = params;
        const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
        const diff = await gh.reads.pullDiff(owner, name, Number(number), signal);
        const result = toToolResult(diff, params);
        // 文本是原始 diff（没有 JSON 形式），载荷从同一份 diff 解析出变更统计
        return withStructuredResult(withPendant(result, params, "number"), {
          text: diff,
          ...parseDiffStats(diff),
        });
      },
    }),
  );
}
