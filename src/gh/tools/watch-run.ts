import { Type } from "typebox";

import { runGh } from "../../lib/gh-process.js";
import { parseWithSchema } from "../../lib/parse-with-schema.js";
import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, ghExec, repoArgs, subtitlePendant } from "../base.js";
import { ghRunPayloadSchema, ghRunSummarySchema } from "../schemas.js";

/** 收尾时查运行状态要的字段（`gh run watch` 自己没有 `--json`）。 */
const RUN_FIELDS =
  "databaseId,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,updatedAt,startedAt,url";

export function addWatchRunTool(_gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "watch-github-run",
      label: "Watch GitHub Workflow Run",
      description:
        "Watch a GitHub Actions workflow run until it completes. " +
        "Blocks until the run finishes and shows the final status.",
      promptSnippet: "Watch and wait for a GitHub Actions run to complete",
      parameters: Type.Object({
        run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      }),
      structuredSchema: ghRunPayloadSchema,
      async execute(_id, params, signal, onUpdate, ctx) {
        const { run_id, repo } = params;

        const pendant = subtitlePendant(params, "run_id");
        onUpdate?.({
          content: [{ type: "text", text: `Watching workflow run ${run_id}...` }],
          details: {},
        });

        const result = await runGh(["run", "watch", String(run_id), ...repoArgs(repo)], {
          cwd: ctx.cwd,
          signal,
          timeout: 600_000,
        });

        if (result.code !== 0) {
          throw new Error(`gh run watch failed: ${result.stderr || `exit code ${result.code}`}`);
        }

        const text = `## Workflow Run ${run_id} Completed\n\n${result.stdout}`;
        // 监控的是状态变化，结论要另外查一次（watch 的文本里只有过程）
        const stdout = await ghExec(
          ["run", "view", String(run_id), ...repoArgs(repo), "--json", RUN_FIELDS],
          { cwd: ctx.cwd, signal, input: params },
        );
        const run = parseWithSchema(ghRunSummarySchema, JSON.parse(stdout));

        return {
          content: [{ type: "text" as const, text }],
          details: { exitCode: 0, input: params, ...(pendant && { pendant }) },
          structuredResult: { ok: true as const, value: { text, run } },
        };
      },
    }),
  );
}
