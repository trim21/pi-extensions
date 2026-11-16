import { z } from "zod";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult } from "../base.js";
import { parseDiffStats } from "../diff-stats.js";
import { ghDiffPayloadSchema } from "../schemas.js";

export function addReadPrDiffTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "read-github-pr-diff",
    label: "GitHub PR Diff",
    description: "Get the diff of a GitHub pull request.",
    parameters: z.object({
      number: z.union([z.number(), z.string()]).describe("PR number"),
      repo: z.string().describe("OWNER/REPO").optional(),
    }),
    structuredSchema: ghDiffPayloadSchema,
    async execute(_id, params, signal, ctx) {
      const { number, repo } = params;
      const { owner, name } = await resolveRepoTarget(repo, signal, ctx.cwd, params);
      const diff = await gh.reads.pullDiff(owner, name, Number(number), signal);
      // diff 没有 JSON 形式，变更统计从原始 diff 解析出来
      return structuredResult(ghDiffPayloadSchema, parseDiffStats(diff));
    },
  });
}
