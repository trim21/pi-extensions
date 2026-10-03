import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  ghExec,
  repoArgs,
  subtitlePendant,
  toToolResult,
  withStructuredResult,
} from "../base.js";
import { parseDiffStats } from "../render.js";
import { ghDiffPayloadSchema } from "../schemas.js";

export function addReadPrDiffTool(_gh: GhClient, bus: ToolBus) {
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
        const args = ["pr", "diff", String(number), ...repoArgs(repo)];
        const stdout = await ghExec(args, { cwd: ctx.cwd, signal, input: params });
        const result = toToolResult(stdout, params);
        result.details.pendant = subtitlePendant(params, "number");
        // 文本仍是原始 diff（`gh pr diff` 没有 --json），载荷从同一份 diff 解析出变更统计
        return withStructuredResult(result, { text: stdout, ...parseDiffStats(stdout) });
      },
    }),
  );
}
