/**
 * `list-github-prs`：与 `list-github-issues` 同一套两条分支（关键词搜索走 octokit 的
 * `/search/issues`，浏览走 REST 列表端点），归一成同一套 `SearchHit`。
 */

import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  browseList,
  type GhClient,
  listFilterParameters,
  type ListFilters,
  renderHitList,
  type StructuredResultOf,
  type ToolCall,
  toToolResult,
  withPendant,
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
  // 文本可能被行数/字节预算截断，载荷给全部命中
  return withStructuredResult(withPendant(result, params), { text, items: hits });
}

export function addListPrsTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "list-github-prs",
      label: "GitHub PRs List",
      description:
        'List GitHub pull requests with optional filters and keyword search. When repo is omitted, keyword search runs across GitHub. Keyword search defaults to open PRs — pass state="merged", state="closed" (merged excluded) or state="all" to broaden. Set fields to choose the columns of each result row.',
      promptSnippet: "List or search GitHub PRs",
      parameters: listFilterParameters("pr"),
      structuredSchema: ghHitListPayloadSchema,
      async execute(_id, params, signal, onUpdate, ctx) {
        return listPrs(gh, { params, ctx, signal, onUpdate });
      },
    }),
  );
}
