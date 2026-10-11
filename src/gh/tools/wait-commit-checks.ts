import { Type } from "typebox";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, type ToolCall, waitChecksReport } from "../base.js";
import { checksVerdictSchema } from "../schemas.js";

interface CommitChecksWaitParams {
  commit: number | string;
  repo?: string;
  event?: string;
  fail_fast?: boolean;
}

/** The toolcall handler behind `wait-github-commit-checks`. */
async function waitCommitChecks(gh: GhClient, call: ToolCall<CommitChecksWaitParams>) {
  const { params, ctx, signal } = call;
  const { commit, repo, event, fail_fast } = params;

  const { owner, name: repoName } = await resolveRepoTarget(repo, signal, ctx.cwd, params);

  const pollSignal = signal ?? new AbortController().signal;
  const sha = await gh.checks.headSha(owner, repoName, String(commit), pollSignal);

  return waitChecksReport({
    checks: gh.checks,
    owner,
    repo: repoName,
    headSha: sha,
    failFast: fail_fast === true,
    event,
    signal,
  });
}

export function addWaitCommitChecksTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "wait-github-commit-checks",
    label: "Watch GitHub Commit Checks",
    description:
      "Watch CI status checks for a commit until they complete — no pull request required. " +
      "Same semantics as wait-github-pr-checks: returns when any check fails (immediately under fail_fast), " +
      'when a workflow is waiting for maintainer approval (`status: "awaiting_approval"`, returned right away), ' +
      "or all checks pass/skip; on timeout the still-in-flight snapshot is returned. " +
      "With `event`, only checks triggered by that workflow event (e.g. push) are judged; " +
      "commit statuses and suites whose workflow run is unknown are excluded under a filter. " +
      "Use this to wait for the runs a commit's push triggered, or for checks on an arbitrary ref.",
    parameters: Type.Object({
      commit: Type.Union([Type.Number(), Type.String()], {
        description:
          "Commit to wait for: full or partial SHA, branch name, or tag name (resolved to the commit's SHA)",
      }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      event: Type.Optional(
        Type.String({
          description:
            "Only judge check runs triggered by this workflow event (e.g. push, pull_request)",
        }),
      ),
      fail_fast: Type.Optional(
        Type.Boolean({ description: "Exit immediately when any check fails (default: false)" }),
      ),
    }),
    structuredSchema: checksVerdictSchema,
    async execute(_id, params, signal, ctx) {
      return waitCommitChecks(gh, { params, ctx, signal });
    },
  });
}
