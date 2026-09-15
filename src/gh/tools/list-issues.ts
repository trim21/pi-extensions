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

async function listIssues(gh: GhClient, call: ToolCall<ListFilters>): Promise<ToolResult> {
  const { params, ctx, signal } = call;
  const result = toToolResult(
    params.keywords
      ? await searchList("issue", params, gh.search)
      : await listGithub("issue", params, { cwd: ctx.cwd, signal, input: params }),
    params,
  );
  result.details.pendant = subtitlePendant(params);
  return result;
}

export function addListIssuesTool(gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "list-github-issues",
    label: "GitHub Issues List",
    description:
      'List GitHub issues with optional filters and keyword search. When repo is omitted, keyword search runs across GitHub. Keyword search defaults to open issues — pass state="all" to include closed ones. Set fields to choose the columns of each result row.',
    promptSnippet: "List or search GitHub issues",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
      keywords: Type.Optional(Type.String({ description: "Search keywords (free text)" })),
      state: Type.Optional(
        Type.String({
          description:
            "open, closed, all (default: open; all applies to keyword search and covers closed too)",
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
            "Comma-separated columns for keyword-search rows (default: number,state,title,labels,updatedAt; adds repo when no repo given). Valid: number,state,title,url,author,labels,milestone,assignees,comments,repo,createdAt,updatedAt,closedAt",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return listIssues(gh, { params, ctx, signal, onUpdate });
    },
  });
}
