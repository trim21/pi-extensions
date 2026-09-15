import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type GhClient,
  type ListFilters,
  listGithub,
  searchList,
  subtitlePendant,
  type ToolCall,
  type ToolResult,
  toToolResult,
} from "../base.js";

async function listPrs(gh: GhClient, call: ToolCall<ListFilters>): Promise<ToolResult> {
  const { params, ctx, signal } = call;
  const result = toToolResult(
    params.keywords
      ? await searchList("pr", params, gh.search)
      : await listGithub("pr", params, { cwd: ctx.cwd, signal, input: params }),
    params,
  );
  result.details.pendant = subtitlePendant(params);
  return result;
}

export function addListPrsTool(gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "list-github-prs",
    label: "GitHub PRs List",
    description:
      'List GitHub pull requests with optional filters and keyword search. When repo is omitted, keyword search runs across GitHub. Keyword search defaults to open PRs — pass state="merged", state="closed" (merged excluded) or state="all" to broaden. Set fields to choose the columns of each result row.',
    promptSnippet: "List or search GitHub PRs",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
      keywords: Type.Optional(Type.String({ description: "Search keywords (free text)" })),
      state: Type.Optional(
        Type.String({
          description:
            "open, closed, merged, all (default: open; all applies to keyword search and covers open + closed + merged)",
        }),
      ),
      label: Type.Optional(Type.String({ description: "Filter by label" })),
      author: Type.Optional(Type.String({ description: "Filter by author" })),
      assignee: Type.Optional(
        Type.String({ description: "Filter by assignee (@me for yourself)" }),
      ),
      milestone: Type.Optional(Type.String({ description: "Filter by milestone" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 30, max 100)" })),
      fields: Type.Optional(
        Type.String({
          description:
            "Comma-separated columns for keyword-search rows (default: number,state,title,labels,updatedAt; adds repo when no repo given). Valid: number,state,title,url,author,labels,milestone,assignees,comments,repo,createdAt,updatedAt,closedAt,mergedAt",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return listPrs(gh, { params, ctx, signal, onUpdate });
    },
  });
}
