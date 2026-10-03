import { Type } from "typebox";
import { Value } from "typebox/value";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepo,
  splitRepo,
  type StructuredResultOf,
  subtitlePendant,
  type ToolCall,
  waitChecksReport,
} from "../base.js";
import { checksVerdictSchema } from "../schemas.js";

interface PrChecksWaitParams {
  number: number | string;
  repo?: string;
  fail_fast?: boolean;
}

/** pulls.get 里我们只需要 head commit 的 SHA（它决定查哪个 commit 的 checks）。 */
const pullHeadSchema = Type.Object({ head: Type.Object({ sha: Type.String() }) });

/** The toolcall handler behind `wait-github-pr-checks`. */
async function waitPrChecks(
  gh: GhClient,
  call: ToolCall<PrChecksWaitParams>,
): Promise<StructuredResultOf<typeof checksVerdictSchema>> {
  const { params, ctx, signal, onUpdate } = call;
  const { number, repo, fail_fast } = params;

  const pendant = subtitlePendant(params, "number");
  onUpdate?.({
    content: [{ type: "text", text: `Watching CI checks for PR #${number}...` }],
    details: {},
  });

  const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
  const { owner, repo: repoName } = splitRepo(effectiveRepo);

  const pull = Value.Parse(
    pullHeadSchema,
    await gh.reads.pull(owner, repoName, Number(number), signal),
  );

  return waitChecksReport({
    checks: gh.checks,
    subject: `PR #${number}`,
    owner,
    repo: repoName,
    headSha: pull.head.sha,
    failFast: fail_fast === true,
    signal,
    onUpdate,
    params,
    pendant,
  });
}

export function addWaitPrChecksTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "wait-github-pr-checks",
      label: "Watch GitHub PR Checks",
      description:
        "Watch CI status checks for a PR until they complete. Blocks until all checks pass (or are skipped) or one fails. " +
        "Covers both commit statuses (Azure DevOps, Jenkins, ...) and GitHub Actions check runs. " +
        "Each polling round streams a compact bullet list of the checks still in flight via onUpdate; " +
        "on timeout the still-in-flight snapshot is returned instead of a verdict. " +
        "Use this when you need to wait for CI to complete and see the final result.",
      promptSnippet: "Watch and wait for GitHub PR CI checks to complete",
      parameters: Type.Object({
        number: Type.Union([Type.Number(), Type.String()], { description: "PR number" }),
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
        fail_fast: Type.Optional(
          Type.Boolean({ description: "Exit immediately when any check fails (default: false)" }),
        ),
      }),
      structuredSchema: checksVerdictSchema,
      async execute(_id, params, signal, onUpdate, ctx) {
        return waitPrChecks(gh, { params, ctx, signal, onUpdate });
      },
    }),
  );
}
