/**
 * gh 列表类工具的共享参数 schema。
 *
 * 放在 `src/lib/` 而不是 `src/gh/`：读取层（`github.ts` / `github-reads.ts`）的入参类型也从
 * 这里派生，字段集只有一处声明，工具层与读取层不会各自漂移。
 */

import { Type } from "typebox";

import { Default, type StaticDefaulted } from "./schema-defaults.js";

/**
 * `list-github-issues` / `list-github-prs` 共用的一套过滤参数，只有 `state` 的说明文案按
 * kind 不同。
 */
export function listFilterParameters(kind: "issue" | "pr") {
  const isPr = kind === "pr";
  return Type.Object({
    repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
    keywords: Type.Optional(Type.String({ description: "Search keywords (free text)" })),
    state: Default(
      Type.String({
        description: isPr
          ? "open, closed, merged, all (all applies to keyword search and covers open + closed + merged)"
          : "open, closed, all (all applies to keyword search and covers closed too)",
      }),
      "open",
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
        description: "Filter by assignee ('@me' works with keywords; browse takes it literally)",
      }),
    ),
    milestone: Type.Optional(Type.String({ description: "Filter by milestone" })),
    limit: Default(Type.Integer({ minimum: 1, maximum: 100, description: "Max results" }), 30),
  });
}

export type ListFilters = StaticDefaulted<ReturnType<typeof listFilterParameters>>;

/** `list-github-workflow-runs` 的参数。 */
export const runListParameters = Type.Object({
  repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
  limit: Default(Type.Integer({ minimum: 1, description: "Max results" }), 20),
  status: Type.Optional(
    Type.String({ description: "Filter by status: success, failure, cancelled, etc." }),
  ),
  workflow: Type.Optional(Type.String({ description: "Filter by workflow name or file" })),
});

export type RunListFilters = StaticDefaulted<typeof runListParameters>;

/** `list-github-releases` 的参数。 */
export const releaseListParameters = Type.Object({
  repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
  limit: Default(Type.Integer({ minimum: 1, description: "Max results" }), 10),
});

export type ReleaseListFilters = StaticDefaulted<typeof releaseListParameters>;
