import { Type } from "typebox";
import { Value } from "typebox/value";

import { type ToolBus } from "../../lib/tool-bus.js";
import { type GhClient, resolveRepoTarget, type ToolCall, waitChecksReport } from "../base.js";
import { checksVerdictSchema } from "../schemas.js";

interface PrChecksWaitParams {
  number: number | string;
  repo?: string;
  fail_fast?: boolean;
}

/** pulls.get 里我们只需要 head commit 的 SHA（它决定查哪个 commit 的 checks）。 */
const pullHeadSchema = Type.Object({ head: Type.Object({ sha: Type.String() }) });

/** The toolcall handler behind `wait-github-pr-checks`. */
async function waitPrChecks(gh: GhClient, call: ToolCall<PrChecksWaitParams>) {
  const { params, ctx, signal } = call;
  const { number, repo, fail_fast } = params;

  const { owner, name: repoName } = await resolveRepoTarget(repo, signal, ctx.cwd, params);

  const pull = Value.Parse(
    pullHeadSchema,
    await gh.reads.pull(owner, repoName, Number(number), signal),
  );

  return waitChecksReport({
    checks: gh.checks,
    owner,
    repo: repoName,
    headSha: pull.head.sha,
    failFast: fail_fast === true,
    signal,
  });
}

export function addWaitPrChecksTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "wait-github-pr-checks",
    label: "Watch GitHub PR Checks",
    description:
      "Watch CI status checks for a PR until they complete. Blocks until all checks pass (or are skipped), " +
      "a check fails, or a workflow turns out to be waiting for maintainer approval — then it returns " +
      '`status: "awaiting_approval"` right away instead of burning the timeout, because such a workflow ' +
      "(a fork PR's first run) never starts on its own. " +
      "Covers commit statuses (Azure DevOps, Jenkins, ...), GitHub Actions check runs, and check suites that " +
      "have no check runs at all (the waiting-for-approval case). " +
      "On timeout the still-in-flight snapshot is returned instead of a verdict. " +
      "Use this when you need to wait for CI to complete and see the final result.",
    parameters: Type.Object({
      number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
      repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      fail_fast: Type.Optional(
        Type.Boolean({ description: "Exit immediately when any check fails (default: false)" }),
      ),
    }),
    structuredSchema: checksVerdictSchema,
    async execute(_id, params, signal, ctx) {
      return waitPrChecks(gh, { params, ctx, signal });
    },
  });
}
