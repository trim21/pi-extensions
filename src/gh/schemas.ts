/**
 * gh-readonly 工具的结构化结果 schema（Zod）。
 *
 * 两个用途：codemode 脚本侧据此渲染 `call()` 的返回类型；工具总线在运行期用它复核
 * `structuredResult.value`。GitHub 的 JSON 只多不少，因此所有字段可选、只对工具本身已经
 * 依赖的字段设 required；多出来的字段不报错但也不保留——`z.object` 解析时剥掉，脚本拿到的
 * 对象正好是这里声明的字段（工具自己的代码受 TypeScript 约束，也只能读这些字段）。
 *
 * 字段名是 GitHub REST 的命名（`html_url` / `created_at` / `user.login`）：gh 工具的取数
 * 全部走 octokit 之后不再有 `gh ... --json` 的 GraphQL 形状。
 */

import { z } from "zod";

import { booleanParam } from "../lib/zod-tool.js";

// ── 共享片段 ─────────────────────────────────────────────────────────────────

/** GitHub 的 actor（author / assignee / mergedBy / review 作者）。 */
export const ghActorSchema = z.object({
  login: z.string().optional(),
  // `user.name` 是 `string | null`：没有显示名的账号返回 null
  name: z.string().nullish(),
  is_bot: z.boolean().optional(),
});

export const ghLabelSchema = z.object({
  name: z.string(),
  color: z.string().optional(),
  // 没有描述的 label 是 `"description": null`（不是缺字段），所以既要 optional 也要 nullable
  description: z.string().nullish(),
});

export const ghMilestoneSchema = z.object({
  title: z.string(),
  number: z.number().optional(),
  dueOn: z.string().nullish(),
});

/** 评论条目：REST 的 issue/PR 评论与行内评审评论共用（`diff_hunk` 只有后者有）。 */
export const ghCommentSchema = z.object({
  id: z.number().optional(),
  body: z.string().nullish(),
  user: ghActorSchema.nullable().optional(),
  path: z.string().optional(),
  line: z.number().nullish(),
  diff_hunk: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  html_url: z.string().optional(),
});

/** 评审条目：REST 的 `/pulls/:n/reviews`。 */
export const ghReviewSchema = z.object({
  id: z.number().optional(),
  body: z.string().nullish(),
  user: ghActorSchema.nullable().optional(),
  state: z.string().optional(),
  submitted_at: z.string().nullish(),
  html_url: z.string().optional(),
});

/** 待评审人：可能是用户（login）也可能是团队（slug）。 */
export const ghReviewRequestSchema = z.object({
  login: z.string().optional(),
  name: z.string().optional(),
  slug: z.string().optional(),
});

/** `read-github-pr-status` / 两个 wait 工具共用的检查桶。 */
export const checkBucketSchema = z.union([
  z.literal("pass"),
  z.literal("fail"),
  z.literal("pending"),
  z.literal("skipped"),
  z.literal("action_required"),
]);

// ── 各工具的输出 ─────────────────────────────────────────────────────────────

/** `read-github-issue`：`issues.get` 的响应（REST 字段名，未读字段不在这里出现也不影响校验）。 */
export const issueViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  body: z.string().nullish(),
  user: ghActorSchema.nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  closed_at: z.string().nullish(),
  html_url: z.string().optional(),
  labels: z.array(ghLabelSchema).optional(),
  assignees: z.array(ghActorSchema).nullish(),
  /** REST 这里给的是评论**数量**（`gh issue view --json comments` 给的是数组）。 */
  comments: z.number().optional(),
  milestone: ghMilestoneSchema.nullable().optional(),
});

/** `read-github-pr`：`pulls.get` 的响应，比 issue 多出合并信息与 diff 统计。 */
export const prViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  body: z.string().nullish(),
  user: ghActorSchema.nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
  merged: z.boolean().optional(),
  merged_by: ghActorSchema.nullable().optional(),
  head: z.object({ ref: z.string().optional() }).optional(),
  base: z.object({ ref: z.string().optional() }).optional(),
  html_url: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changed_files: z.number().optional(),
  labels: z.array(ghLabelSchema).optional(),
  assignees: z.array(ghActorSchema).nullish(),
  requested_reviewers: z.array(ghReviewRequestSchema).nullish(),
  milestone: ghMilestoneSchema.nullable().optional(),
});

/**
 * 两个评论工具共用：`issues.listComments` 或 `pulls.listReviewComments` 的数组。
 * `reviews: true`（只对 PR）时额外带 `pulls.listReviews` 的结果。
 */
export const issueCommentsSchema = z.strictObject({
  comments: z.array(ghCommentSchema).describe("该 issue / PR 的评论（分页取全）"),
});

export const prCommentsSchema = z.strictObject({
  comments: z.array(ghCommentSchema).optional(),
  reviews: z.array(ghReviewSchema).optional(),
});

/** `read-github-pr-status`：工具自己拼的 `{pr, repo, head_sha, checks}`。 */
export const prStatusSchema = z.strictObject({
  pr: z.number(),
  repo: z.string(),
  head_sha: z.string(),
  checks: z.array(
    z.strictObject({
      name: z.string(),
      bucket: checkBucketSchema,
      event: z.string().nullable(),
      run_id: z.number().nullable(),
      job_id: z.number().nullable(),
      suite_id: z.number().nullable(),
      url: z.string().nullable(),
    }),
  ),
});

/** `get-github-workflow-jobs`：`{total_count, jobs}` 由工具拼，`jobs` / `steps` 是 REST 原行。 */
export const workflowJobsSchema = z.strictObject({
  total_count: z.number(),
  jobs: z.array(
    z.object({
      id: z.number(),
      run_id: z.number(),
      run_url: z.string(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string().nullable(),
      steps: z.array(
        z.object({
          name: z.string(),
          number: z.number(),
          status: z.string(),
          conclusion: z.string().nullable(),
          started_at: z.string().nullish(),
        }),
      ),
    }),
  ),
});

/** `read-github-ci-logs`：`CiLogsJobIndex`（步骤带它在原始日志里的行号范围）。 */
export const ciLogsSchema = z.strictObject({
  name: z.string(),
  id: z.number(),
  status: z.string(),
  conclusion: z.string().nullable(),
  log_file: z.string(),
  steps: z.array(
    z.strictObject({
      number: z.number(),
      name: z.string(),
      conclusion: z.string().nullable(),
      start_line: z.number().optional(),
      end_line: z.number().optional(),
    }),
  ),
});

/** `download-github-release-assets`：下载目录里此刻的文件清单。 */
export const releaseDownloadSchema = z.strictObject({
  repo: z.string(),
  tag: z.string(),
  dir: z.string(),
  files: z.array(z.strictObject({ name: z.string(), path: z.string(), bytes: z.number() })),
});

/** 两个 wait 工具共享的判定结果（`waitChecksReport` 的 payload）。 */
export const checksVerdictSchema = z.strictObject({
  status: z.union([
    z.literal("success"),
    z.literal("failure"),
    z.literal("pending"),
    z.literal("awaiting_approval"),
  ]),
  totalChecks: z.number(),
  checks: z.array(
    z.strictObject({
      name: z.string(),
      bucket: checkBucketSchema,
      startedAt: z.string().nullable(),
      link: z.string().nullable(),
      event: z.string().nullable(),
      suiteId: z.number().nullable(),
      runId: z.number().nullable(),
      jobId: z.number().nullable(),
    }),
  ),
  failedJobs: z.array(
    z.strictObject({
      runId: z.number(),
      runName: z.string(),
      runUrl: z.string(),
      jobId: z.number(),
      jobName: z.string(),
      conclusion: z.string(),
      jobUrl: z.string().optional(),
    }),
  ),
});

// ── 各工具的载荷 ────────────────────────────────────────────────────────────
//
// 载荷是脚本侧唯一输出：REST 响应的原物（字段名保持 REST 命名），列表类工具给全部命中。
// 与上面十个透传工具一样，gh 的 JSON 允许额外字段。

/** `list-github-issues` / `list-github-prs` 的一行：浏览与搜索两条分支归一后的记录。 */
export const ghHitSchema = z.strictObject({
  number: z.number(),
  state: z.union([z.literal("open"), z.literal("closed"), z.literal("merged")]),
  title: z.string(),
  url: z.string(),
  repo: z.string().describe("OWNER/REPO；浏览分支取参数或当前仓库"),
  author: z.string(),
  labels: z.array(z.string()),
  milestone: z.string(),
  assignees: z.array(z.string()),
  comments: z.number().describe("评论数（浏览分支是评论数组的长度）"),
  createdAt: z.string().describe("YYYY-MM-DD"),
  updatedAt: z.string().describe("YYYY-MM-DD"),
  closedAt: z.string(),
  mergedAt: z.string(),
});

export const ghHitListPayloadSchema = z.strictObject({
  items: z.array(ghHitSchema).describe("全部命中"),
});

/** `repos.listReleases` 的一行（REST 字段名）。 */
export const ghReleaseSummarySchema = z.object({
  tag_name: z.string(),
  name: z.string().nullish(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullish(),
  created_at: z.string().optional(),
});

export const ghReleaseListPayloadSchema = z.strictObject({
  releases: z.array(ghReleaseSummarySchema),
});

/** `actions.listWorkflowRuns*` / `getWorkflowRun` 的共同字段（REST 字段名）。 */
export const ghRunSummarySchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  display_title: z.string().optional(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  head_branch: z.string().nullish(),
  event: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  run_started_at: z.string().optional(),
  html_url: z.string().optional(),
});

export const ghRunListPayloadSchema = z.strictObject({
  runs: z.array(ghRunSummarySchema),
});

/** `watch-github-run`：文本是轮询进度与完成报告，载荷是收尾时查到的运行状态。 */
export const ghRunPayloadSchema = z.strictObject({
  run: ghRunSummarySchema,
});

/** `repos.get` 里我们渲染与脚本可能用到的字段（REST 字段名）。 */
export const ghRepoViewSchema = z.object({
  name: z.string().optional(),
  full_name: z.string().optional(),
  description: z.string().nullish(),
  html_url: z.string().optional(),
  homepage: z.string().nullish(),
  private: z.boolean().optional(),
  fork: z.boolean().optional(),
  archived: z.boolean().optional(),
  visibility: z.string().optional(),
  language: z.string().nullish(),
  default_branch: z.string().optional(),
  stargazers_count: z.number().optional(),
  forks_count: z.number().optional(),
  open_issues_count: z.number().optional(),
  license: z.object({ name: z.string().optional() }).nullish(),
  pushed_at: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/** `repos.getReleaseByTag` / `getLatestRelease` 里我们渲染与脚本可能用到的字段。 */
export const ghReleaseViewSchema = z.object({
  tag_name: z.string().optional(),
  name: z.string().nullish(),
  body: z.string().nullish(),
  html_url: z.string().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  created_at: z.string().optional(),
  published_at: z.string().nullish(),
  target_commitish: z.string().optional(),
  author: ghActorSchema.nullable().optional(),
  assets: z
    .array(
      z.object({
        id: z.number().optional(),
        name: z.string().optional(),
        size: z.number().optional(),
        download_count: z.number().optional(),
        content_type: z.string().optional(),
        state: z.string().optional(),
        browser_download_url: z.string().optional(),
      }),
    )
    .optional(),
});

export const ghReleaseViewPayloadSchema = z.strictObject({
  release: ghReleaseViewSchema,
});

/** `repos.get` 的载荷：文本 + REST 响应。 */
export const ghRepoPayloadSchema = z.strictObject({
  repo: ghRepoViewSchema,
});

/** `read-github-pr-diff`：文本是原始 diff，载荷是从它解析出的变更统计。 */
export const ghDiffPayloadSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      path: z.string(),
      additions: z.number(),
      deletions: z.number(),
      /** diff 里的旧路径，重命名/复制时与 `path` 不同。 */
      oldPath: z.string().optional(),
    }),
  ),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
});

// ── 工具参数 ────────────────────────────────────────────────────────────────
//
// 参数 schema 是工具参数的唯一来源：handler 的入参类型由总线按 `z.output` 推断（带
// `.default()` 的字段必有值），不再另写一份 TS interface。

/** 两个 wait 工具共用的 `repo` 参数。 */
const checksWaitRepoSchema = z.string().describe("OWNER/REPO").optional();

/**
 * 两个 wait 工具共用的 `fail_fast`：任一检查失败时是否立即返回。
 *
 * 默认值经 `.default(true)` 声明，因此同时进入 JSON Schema（codemode 声明渲染成
 * `@default true`）与类型（`z.output` 里该字段必填），handler 不再写兜底。
 */
const checksWaitFailFastSchema = booleanParam({ default: true }).describe(
  "Exit immediately when any check fails; false waits for the remaining checks",
);

/** `wait-github-pr-checks` 的参数。 */
export const waitPrChecksParameters = z.object({
  number: z.union([z.number(), z.string()]).describe("PR number"),
  repo: checksWaitRepoSchema,
  fail_fast: checksWaitFailFastSchema,
});

/** `wait-github-commit-checks` 的参数。 */
export const waitCommitChecksParameters = z.object({
  commit: z
    .union([z.number(), z.string()])
    .describe(
      "Commit to wait for: full or partial SHA, branch name, or tag name (resolved to the commit's SHA)",
    ),
  repo: checksWaitRepoSchema,
  event: z
    .string()
    .describe("Only judge check runs triggered by this workflow event (e.g. push, pull_request)")
    .optional(),
  fail_fast: checksWaitFailFastSchema,
});
