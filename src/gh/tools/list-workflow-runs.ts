import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type GhClient, ghExec, repoArgs, subtitlePendant, toToolResult } from "../base.js";

export function addListWorkflowRunsTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "list-github-workflow-runs",
    label: "GitHub Workflow Runs",
    description: "List GitHub Actions workflow runs.",
    promptSnippet: "List GitHub workflow runs",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
      status: Type.Optional(
        Type.String({ description: "Filter by status: success, failure, cancelled, etc." }),
      ),
      workflow: Type.Optional(Type.String({ description: "Filter by workflow name or file" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { repo, limit, status, workflow } = params;
      const args = ["run", "list", ...repoArgs(repo)];
      if (limit) {
        args.push("--limit", String(limit));
      }
      if (status) {
        args.push("--status", status);
      }
      if (workflow) {
        args.push("--workflow", workflow);
      }
      const result = toToolResult(
        await ghExec(args, { cwd: ctx.cwd, signal, input: params }),
        params,
      );
      result.details.pendant = subtitlePendant(params);
      return result;
    },
  });
}
