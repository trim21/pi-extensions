/**
 * `list-github-issues`：两条取数分支（关键词搜索走 octokit 的 `/search/issues`，浏览走
 * REST 列表端点）归一成同一套 `SearchHit`，因此文本渲染与结构化载荷只有一份实现。
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

async function listIssues(
  gh: GhClient,
  call: ToolCall<ListFilters>,
): Promise<StructuredResultOf<typeof ghHitListPayloadSchema>> {
  const { params, ctx, signal } = call;
  const { repo, hits } = params.keywords
    ? { repo: params.repo, hits: await gh.search.search("issue", params) }
    : await browseList(gh, "issue", params, { cwd: ctx.cwd, signal, input: params });
  const text = renderHitList("issue", hits, { repo, fields: params.fields });
  const result = toToolResult(text, params);
  // 文本可能被行数/字节预算截断，载荷给全部命中
  return withStructuredResult(withPendant(result, params), { text, items: hits });
}

export function addListIssuesTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "list-github-issues",
      label: "GitHub Issues List",
      description:
        'List GitHub issues with optional filters and keyword search. When repo is omitted, keyword search runs across GitHub. Keyword search defaults to open issues — pass state="all" to include closed ones. Set fields to choose the columns of each result row.',
      promptSnippet: "List or search GitHub issues",
      parameters: listFilterParameters("issue"),
      structuredSchema: ghHitListPayloadSchema,
      async execute(_id, params, signal, onUpdate, ctx) {
        return listIssues(gh, { params, ctx, signal, onUpdate });
      },
    }),
  );
}
