/**
 * `list-github-prs`：与 `list-github-issues` 同一套两条分支（关键词搜索走 octokit 的
 * `/search/issues`，浏览走 REST 列表端点），归一成同一套 `SearchHit`。
 */

import { type ToolBus } from "../../lib/tool-bus.js";
import {
  browseList,
  type GhClient,
  listFilterParameters,
  type ListFilters,
  structuredResult,
  type ToolCall,
} from "../base.js";
import { ghHitListPayloadSchema } from "../schemas.js";

async function listPrs(gh: GhClient, call: ToolCall<ListFilters>) {
  const { params, ctx, signal } = call;
  const hits = params.keywords
    ? await gh.search.search("pr", params)
    : await browseList(gh, "pr", params, { cwd: ctx.cwd, signal, input: params });
  return structuredResult(ghHitListPayloadSchema, { items: hits });
}

export function addListPrsTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "list-github-prs",
    label: "GitHub PRs List",
    description:
      'List GitHub pull requests with optional filters and keyword search. When repo is omitted, keyword search runs across GitHub. Keyword search defaults to open PRs — pass state="merged", state="closed" (merged excluded) or state="all" to broaden.',
    parameters: listFilterParameters("pr"),
    structuredSchema: ghHitListPayloadSchema,
    async execute(_id, params, signal, ctx) {
      return listPrs(gh, { params, ctx, signal });
    },
  });
}
