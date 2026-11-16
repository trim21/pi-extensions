import type { z } from "zod";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, type ToolCall, waitChecksReport } from "../base.js";
import { checksVerdictSchema, waitCommitChecksParameters } from "../schemas.js";

/** 入参类型由参数 schema 推断：`fail_fast` 有默认值，解析后必填。 */
type CommitChecksWaitParams = z.infer<typeof waitCommitChecksParameters>;

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
    failFast: fail_fast,
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
      "Same semantics as wait-github-pr-checks: returns as soon as any check fails " +
      "(pass `fail_fast: false` to wait for the remaining checks), " +
      'when a workflow is waiting for maintainer approval (`status: "awaiting_approval"`, returned right away), ' +
      "or all checks pass/skip; on timeout the still-in-flight snapshot is returned. " +
      "With `event`, only checks triggered by that workflow event (e.g. push) are judged; " +
      "commit statuses and suites whose workflow run is unknown are excluded under a filter. " +
      "Use this to wait for the runs a commit's push triggered, or for checks on an arbitrary ref.",
    parameters: waitCommitChecksParameters,
    structuredSchema: checksVerdictSchema,
    async execute(_id, params, signal, ctx) {
      return waitCommitChecks(gh, { params, ctx, signal });
    },
  });
}
