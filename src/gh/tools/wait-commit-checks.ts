import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type GhClient,
  resolveRepo,
  splitRepo,
  subtitlePendant,
  type ToolCall,
  type ToolResult,
  waitChecksReport,
} from "../base.js";

interface CommitChecksWaitParams {
  commit: number | string;
  repo?: string;
  event?: string;
  fail_fast?: boolean;
}

/** The toolcall handler behind `wait-github-commit-checks`. */
async function waitCommitChecks(
  gh: GhClient,
  call: ToolCall<CommitChecksWaitParams>,
): Promise<ToolResult> {
  const { params, ctx, signal, onUpdate } = call;
  const { commit, repo, event, fail_fast } = params;

  const pendant = subtitlePendant(params, "commit");
  onUpdate?.({
    content: [{ type: "text", text: `Watching CI checks for commit ${commit}...` }],
    details: {},
  });

  const effectiveRepo = await resolveRepo(repo, signal, ctx.cwd, params);
  const { owner, repo: repoName } = splitRepo(effectiveRepo);

  const pollSignal = signal ?? new AbortController().signal;
  const sha = await gh.checks.headSha(owner, repoName, String(commit), pollSignal);

  return waitChecksReport({
    checks: gh.checks,
    subject: `commit ${sha.slice(0, 7)}`,
    owner,
    repo: repoName,
    headSha: sha,
    failFast: fail_fast === true,
    event,
    signal,
    onUpdate,
    params,
    pendant,
  });
}

export function addWaitCommitChecksTool(gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "wait-github-commit-checks",
    label: "Watch GitHub Commit Checks",
    description:
      "Watch CI status checks for a commit until they complete — no pull request required. " +
      "Same semantics as wait-github-pr-checks: returns when any check fails (immediately under fail_fast) " +
      "or all checks pass/skip; on timeout the still-in-flight snapshot is returned. " +
      "With `event`, only check runs triggered by that workflow event (e.g. push) are judged; " +
      "commit statuses have an unknown trigger event and are excluded under a filter. " +
      "Use this to wait for the runs a commit's push triggered, or for checks on an arbitrary ref.",
    promptSnippet: "Watch and wait for GitHub commit CI checks to complete",
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
    async execute(_id, params, signal, onUpdate, ctx) {
      return waitCommitChecks(gh, { params, ctx, signal, onUpdate });
    },
  });
}
