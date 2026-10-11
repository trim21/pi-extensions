import { Type } from "typebox";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, structuredResult, watchRun } from "../base.js";
import { ghRunPayloadSchema } from "../schemas.js";

export function addWatchRunTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "watch-github-run",
    label: "Watch GitHub Workflow Run",
    description:
      "Watch a GitHub Actions workflow run until it completes. " +
      "Blocks until the run finishes and returns its final status.",
    parameters: Type.Object({
      run_id: Type.Union([Type.Number(), Type.String()], { description: "Workflow run ID" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
    }),
    structuredSchema: ghRunPayloadSchema,
    async execute(_id, params, signal, ctx) {
      const { run_id, repo } = params;

      // 轮询循环要求非空 signal（与两个 wait 工具一致：没有就自建一个）
      const pollSignal = signal ?? new AbortController().signal;
      const { owner, name: repoName } = await resolveRepoTarget(repo, pollSignal, ctx.cwd, params);
      const outcome = await watchRun({
        owner,
        repo: repoName,
        runId: Number(run_id),
        reads: gh.reads,
        signal: pollSignal,
      });

      if (outcome.outcome === "timeout") {
        const state = outcome.run.conclusion ?? outcome.run.status ?? "unknown";
        throw new Error(
          `workflow run ${run_id} did not finish within ${Math.round(outcome.elapsedMs / 1000)}s; last status: ${state}`,
        );
      }

      return structuredResult(ghRunPayloadSchema, { run: outcome.run });
    },
  });
}
