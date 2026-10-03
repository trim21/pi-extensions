import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  renderRunStatus,
  resolveRepoTarget,
  subtitlePendant,
  type ToolResult,
  watchRun,
} from "../base.js";
import { ghRunPayloadSchema } from "../schemas.js";

export function addWatchRunTool(gh: GhClient, bus: ToolBus) {
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
        const publish = (message: ToolResult) => onUpdate?.(message);
        publish({
          content: [{ type: "text", text: `Watching workflow run ${run_id}...` }],
          details: {},
        });

        // 轮询循环要求非空 signal（与两个 wait 工具一致：没有就自建一个）
        const pollSignal = signal ?? new AbortController().signal;
        const { owner, name: repoName } = await resolveRepoTarget(
          repo,
          pollSignal,
          ctx.cwd,
          params,
        );
        const outcome = await watchRun({
          owner,
          repo: repoName,
          runId: Number(run_id),
          reads: gh.reads,
          signal: pollSignal,
          onUpdate: publish,
        });

        if (outcome.outcome === "timeout") {
          throw new Error(
            `workflow run ${run_id} did not finish within ${Math.round(outcome.elapsedMs / 1000)}s; last status: ${renderRunStatus(outcome.run)}`,
          );
        }

        const heading =
          outcome.run.conclusion === "success"
            ? `## Workflow Run ${run_id} Completed`
            : `## Workflow Run ${run_id} Finished (${outcome.run.conclusion ?? "unknown"})`;
        const text = `${heading}\n\n${renderRunStatus(outcome.run)}`;

        return {
          content: [{ type: "text" as const, text }],
          details: { input: params, ...(pendant && { pendant }) },
          structuredResult: { ok: true as const, value: { text, run: outcome.run } },
        };
      },
    }),
  );
}
