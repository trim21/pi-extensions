/**
 * gh 列表类工具的共享参数 schema。
 *
 * 放在 `src/lib/` 而不是 `src/gh/`：读取层（`github.ts` / `github-reads.ts`）的入参类型也从
 * 这里派生，字段集只有一处声明，工具层与读取层不会各自漂移。
 */

import { z } from "zod";

/**
 * `list-github-issues` / `list-github-prs` 共用的一套过滤参数，只有 `state` 的说明文案按
 * kind 不同。
 */
export function listFilterParameters(kind: "issue" | "pr") {
  const isPr = kind === "pr";
  return z.object({
    repo: z.string().describe("OWNER/REPO (defaults to current repo)").optional(),
    keywords: z.string().describe("Search keywords (free text)").optional(),
    state: z
      .string()
      .describe(
        isPr
          ? "open, closed, merged, all (all applies to keyword search and covers open + closed + merged)"
          : "open, closed, all (all applies to keyword search and covers closed too)",
      )
      .default("open"),
    label: z.string().describe("Filter by label").optional(),
    // `@me` 只在关键词搜索分支可用：搜索 API 自己把它解析成当前登录用户。浏览分支走
    // REST 列表端点，`@me` 按字面量转发，不会匹配到当前用户（本仓库不做展开）。
    author: z
      .string()
      .describe("Filter by author ('@me' works with keywords; browse takes it literally)")
      .optional(),
    assignee: z
      .string()
      .describe("Filter by assignee ('@me' works with keywords; browse takes it literally)")
      .optional(),
    milestone: z.string().describe("Filter by milestone").optional(),
    limit: z.coerce.number().int().min(1).max(100).describe("Max results").default(30),
  });
}

/** 解析后的参数：默认值已补齐，`state` / `limit` 一定有值（工具 handler 里用）。 */
export type ListFilters = z.infer<ReturnType<typeof listFilterParameters>>;

/** 调用方传入的参数：带默认值的字段可以省略（读取层与测试里用）。 */
export type ListFilterInput = z.input<ReturnType<typeof listFilterParameters>>;

/** `list-github-workflow-runs` 的参数。 */
export const runListParameters = z.object({
  repo: z.string().describe("OWNER/REPO").optional(),
  limit: z.coerce.number().int().min(1).describe("Max results").default(20),
  status: z.string().describe("Filter by status: success, failure, cancelled, etc.").optional(),
  workflow: z.string().describe("Filter by workflow name or file").optional(),
});

export type RunListFilters = z.infer<typeof runListParameters>;

/** `list-github-releases` 的参数。 */
export const releaseListParameters = z.object({
  repo: z.string().describe("OWNER/REPO").optional(),
  limit: z.coerce.number().int().min(1).describe("Max results").default(10),
});

export type ReleaseListFilters = z.infer<typeof releaseListParameters>;
