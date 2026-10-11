/**
 * `list-github-issues`：两条取数分支（关键词搜索走 octokit 的 `/search/issues`，浏览走
 * REST 列表端点）归一成同一套 `SearchHit`，作为结构化结果交给 codemode 脚本。
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

async function listIssues(gh: GhClient, call: ToolCall<ListFilters>) {
  const { params, ctx, signal } = call;
  const hits = params.keywords
    ? await gh.search.search("issue", params)
    : await browseList(gh, "issue", params, { cwd: ctx.cwd, signal, input: params });
  return structuredResult(ghHitListPayloadSchema, { items: hits });
}

export function addListIssuesTool(gh: GhClient, bus: ToolBus) {
  bus.registerCodemodeOnly({
    name: "list-github-issues",
    label: "GitHub Issues List",
    description:
      'List GitHub issues with optional filters and keyword search. When repo is omitted, keyword search runs across GitHub. Keyword search defaults to open issues — pass state="all" to include closed ones.',
    parameters: listFilterParameters("issue"),
    structuredSchema: ghHitListPayloadSchema,
    async execute(_id, params, signal, ctx) {
      return listIssues(gh, { params, ctx, signal });
    },
  });
}
