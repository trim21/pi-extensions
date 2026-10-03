/**
 * `list-github-prs`：与 `list-github-issues` 同一套两条分支（关键词搜索走 octokit，
 * 浏览走 `gh pr list --json`），归一成同一套 `SearchHit`。
 */

import { Type } from "typebox";

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  browseList,
  type GhClient,
  type ListFilters,
  renderHitList,
  type StructuredResultOf,
  subtitlePendant,
  type ToolCall,
  toToolResult,
  withStructuredResult,
} from "../base.js";
import { ghHitListPayloadSchema } from "../schemas.js";

async function listPrs(
  gh: GhClient,
  call: ToolCall<ListFilters>,
): Promise<StructuredResultOf<typeof ghHitListPayloadSchema>> {
  const { params, ctx, signal } = call;
  const { repo, hits } = params.keywords
    ? { repo: params.repo, hits: await gh.search.search("pr", params) }
    : await browseList(gh, "pr", params, { cwd: ctx.cwd, signal, input: params });
  const text = renderHitList("pr", hits, { repo, fields: params.fields });
  const result = toToolResult(text, params);
  result.details.pendant = subtitlePendant(params);
  // 文本可能被行数/字节预算截断，载荷给全部命中
  return withStructuredResult(result, { text, items: hits });
}

export function addListPrsTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
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
        // `@me` 只在关键词搜索分支可用：搜索 API 自己把它解析成当前登录用户。浏览分支走
        // REST 列表端点，`@me` 按字面量转发，不会匹配到当前用户（本仓库不做展开）。
        author: Type.Optional(
          Type.String({
            description: "Filter by author ('@me' works with keywords; browse takes it literally)",
          }),
        ),
        assignee: Type.Optional(
          Type.String({
            description:
              "Filter by assignee ('@me' works with keywords; browse takes it literally)",
          }),
        ),
        milestone: Type.Optional(Type.String({ description: "Filter by milestone" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default 30, max 100)" })),
        fields: Type.Optional(
          Type.String({
            description:
              "Comma-separated columns for the rows (default: number,state,title,labels,updatedAt; adds repo when no repo given). Valid: number,state,title,url,author,labels,milestone,assignees,comments,repo,createdAt,updatedAt,closedAt,mergedAt",
          }),
        ),
      }),
      structuredSchema: ghHitListPayloadSchema,
      async execute(_id, params, signal, onUpdate, ctx) {
        return listPrs(gh, { params, ctx, signal, onUpdate });
      },
    }),
  );
}
