import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type GhClient, repoArgs, runGh, subtitlePendant } from "../base.js";

export function addWatchRunTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
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

      return {
        content: [
          { type: "text", text: `## Workflow Run ${run_id} Completed\n\n${result.stdout}` },
        ],
        details: { exitCode: 0, input: params, ...(pendant && { pendant }) },
      };
    },
  });
}
