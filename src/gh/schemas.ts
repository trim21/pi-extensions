/**
 * gh-readonly 工具的结构化结果 schema（TypeBox）。
 *
 * 两个用途：codemode 脚本侧据此渲染 `call()` 的返回类型；工具总线在运行期用它复核
 * `structuredResult.value`。因此 schema 必须**允许额外字段**（GitHub 的 JSON 只多不少，
 * 多出来的字段不该让工具失败），只对工具本身已经依赖的字段设 required。
 *
 * 字段名是 GitHub REST 的命名（`html_url` / `created_at` / `user.login`）：gh 工具的取数
 * 全部走 octokit 之后不再有 `gh ... --json` 的 GraphQL 形状。
 */

import { Type } from "typebox";

// ── 共享片段 ─────────────────────────────────────────────────────────────────

/** GitHub 的 actor（author / assignee / mergedBy / review 作者）。 */
export const ghActorSchema = Type.Object({
  login: Type.Optional(Type.String()),
  // `user.name` 是 `string | null`：没有显示名的账号返回 null
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  is_bot: Type.Optional(Type.Boolean()),
});

export const ghLabelSchema = Type.Object({
  name: Type.String(),
  color: Type.Optional(Type.String()),
  // 没有描述的 label 是 `"description": null`（不是缺字段），所以既要 optional 也要 nullable
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const ghMilestoneSchema = Type.Object({
  title: Type.String(),
  number: Type.Optional(Type.Number()),
  dueOn: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/** 评论条目：REST 的 issue/PR 评论与行内评审评论共用（`diff_hunk` 只有后者有）。 */
export const ghCommentSchema = Type.Object({
  id: Type.Optional(Type.Number()),
  body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  user: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  path: Type.Optional(Type.String()),
  line: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  diff_hunk: Type.Optional(Type.String()),
  created_at: Type.Optional(Type.String()),
  updated_at: Type.Optional(Type.String()),
  html_url: Type.Optional(Type.String()),
});

/** 评审条目：REST 的 `/pulls/:n/reviews`。 */
export const ghReviewSchema = Type.Object({
  id: Type.Optional(Type.Number()),
  body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  user: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  state: Type.Optional(Type.String()),
  submitted_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  html_url: Type.Optional(Type.String()),
});

/** 待评审人：可能是用户（login）也可能是团队（slug）。 */
export const ghReviewRequestSchema = Type.Object({
  login: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
});

/** `read-github-pr-status` / 两个 wait 工具共用的检查桶。 */
export const checkBucketSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("pending"),
  Type.Literal("skipped"),
]);

// ── 各工具的输出 ─────────────────────────────────────────────────────────────

/** `read-github-issue`：`issues.get` 的响应（REST 字段名，未读字段不在这里出现也不影响校验）。 */
export const issueViewSchema = Type.Object({
  number: Type.Number(),
  title: Type.String(),
  state: Type.String(),
  body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  user: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  created_at: Type.Optional(Type.String()),
  updated_at: Type.Optional(Type.String()),
  closed_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  html_url: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Array(ghLabelSchema)),
  assignees: Type.Optional(Type.Union([Type.Array(ghActorSchema), Type.Null()])),
  /** REST 这里给的是评论**数量**（`gh issue view --json comments` 给的是数组）。 */
  comments: Type.Optional(Type.Number()),
  milestone: Type.Optional(Type.Union([ghMilestoneSchema, Type.Null()])),
});

/** `read-github-pr`：`pulls.get` 的响应，比 issue 多出合并信息与 diff 统计。 */
export const prViewSchema = Type.Object({
  number: Type.Number(),
  title: Type.String(),
  state: Type.String(),
  body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  user: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  created_at: Type.Optional(Type.String()),
  updated_at: Type.Optional(Type.String()),
  closed_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  merged_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  merged: Type.Optional(Type.Boolean()),
  merged_by: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  head: Type.Optional(Type.Object({ ref: Type.Optional(Type.String()) })),
  base: Type.Optional(Type.Object({ ref: Type.Optional(Type.String()) })),
  html_url: Type.Optional(Type.String()),
  additions: Type.Optional(Type.Number()),
  deletions: Type.Optional(Type.Number()),
  changed_files: Type.Optional(Type.Number()),
  labels: Type.Optional(Type.Array(ghLabelSchema)),
  assignees: Type.Optional(Type.Union([Type.Array(ghActorSchema), Type.Null()])),
  requested_reviewers: Type.Optional(Type.Union([Type.Array(ghReviewRequestSchema), Type.Null()])),
  milestone: Type.Optional(Type.Union([ghMilestoneSchema, Type.Null()])),
});

/**
 * 两个评论工具共用：`issues.listComments` 或 `pulls.listReviewComments` 的数组。
 * `reviews: true`（只对 PR）时额外带 `pulls.listReviews` 的结果。
 */
export const issueCommentsSchema = Type.Object({
  comments: Type.Array(ghCommentSchema, { description: "该 issue / PR 的评论（分页取全）" }),
});

export const prCommentsSchema = Type.Object({
  comments: Type.Optional(Type.Array(ghCommentSchema)),
  reviews: Type.Optional(Type.Array(ghReviewSchema)),
});

/** `read-github-pr-status`：工具自己拼的 `{pr, repo, head_sha, checks}`。 */
export const prStatusSchema = Type.Object({
  pr: Type.Number(),
  repo: Type.String(),
  head_sha: Type.String(),
  checks: Type.Array(
    Type.Object({
      name: Type.String(),
      bucket: checkBucketSchema,
      event: Type.Union([Type.String(), Type.Null()]),
      run_id: Type.Union([Type.Number(), Type.Null()]),
      job_id: Type.Union([Type.Number(), Type.Null()]),
      url: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});

export const workflowJobsSchema = Type.Object({
  total_count: Type.Number(),
  jobs: Type.Array(
    Type.Object({
      id: Type.Number(),
      run_id: Type.Number(),
      run_url: Type.String(),
      name: Type.String(),
      status: Type.String(),
      conclusion: Type.Union([Type.String(), Type.Null()]),
      html_url: Type.Union([Type.String(), Type.Null()]),
      steps: Type.Array(
        Type.Object({
          name: Type.String(),
          number: Type.Number(),
          status: Type.String(),
          conclusion: Type.Union([Type.String(), Type.Null()]),
          started_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
      ),
    }),
  ),
});

/** `read-github-ci-logs`：`CiLogsJobIndex`（步骤带它在原始日志里的行号范围）。 */
export const ciLogsSchema = Type.Object({
  name: Type.String(),
  id: Type.Number(),
  status: Type.String(),
  conclusion: Type.Union([Type.String(), Type.Null()]),
  log_file: Type.String(),
  steps: Type.Array(
    Type.Object({
      number: Type.Number(),
      name: Type.String(),
      conclusion: Type.Union([Type.String(), Type.Null()]),
      start_line: Type.Optional(Type.Number()),
      end_line: Type.Optional(Type.Number()),
    }),
  ),
});

/** `download-github-release-assets`：下载目录里此刻的文件清单。 */
export const releaseDownloadSchema = Type.Object({
  repo: Type.String(),
  tag: Type.String(),
  dir: Type.String(),
  files: Type.Array(
    Type.Object({ name: Type.String(), path: Type.String(), bytes: Type.Number() }),
  ),
});

/** 两个 wait 工具共享的判定结果（`waitChecksReport` 的 payload）。 */
export const checksVerdictSchema = Type.Object({
  status: Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("pending")]),
  totalChecks: Type.Number(),
  checks: Type.Array(
    Type.Object({
      name: Type.String(),
      bucket: checkBucketSchema,
      startedAt: Type.Union([Type.String(), Type.Null()]),
      link: Type.Union([Type.String(), Type.Null()]),
      event: Type.Union([Type.String(), Type.Null()]),
      runId: Type.Union([Type.Number(), Type.Null()]),
      jobId: Type.Union([Type.Number(), Type.Null()]),
    }),
  ),
  failedJobs: Type.Array(
    Type.Object({
      runId: Type.Number(),
      runName: Type.String(),
      runUrl: Type.String(),
      jobId: Type.Number(),
      jobName: Type.String(),
      conclusion: Type.String(),
      jobUrl: Type.Optional(Type.String()),
    }),
  ),
});

// ── 文本类工具改成 --json 之后的载荷 ─────────────────────────────────────────
//
// 这批工具的文本由我们自己从 JSON 渲染，因此载荷是 gh 的 JSON（字段名就是 gh 的）加一个
// `text`（与工具输出一致）。与上面十个透传工具一样，gh 的 JSON 允许额外字段。

/** `list-github-issues` / `list-github-prs` 的一行：浏览与搜索两条分支归一后的记录。 */
export const ghHitSchema = Type.Object(
  {
    number: Type.Number(),
    state: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged")]),
    title: Type.String(),
    url: Type.String(),
    repo: Type.String({ description: "OWNER/REPO；浏览分支取参数或当前仓库" }),
    author: Type.String(),
    labels: Type.Array(Type.String()),
    milestone: Type.String(),
    assignees: Type.Array(Type.String()),
    comments: Type.Number({ description: "评论数（浏览分支是评论数组的长度）" }),
    createdAt: Type.String({ description: "YYYY-MM-DD" }),
    updatedAt: Type.String({ description: "YYYY-MM-DD" }),
    closedAt: Type.String(),
    mergedAt: Type.String(),
  },
  { additionalProperties: false },
);

export const ghHitListPayloadSchema = Type.Object(
  {
    text: Type.String({ description: "与工具输出一致的行列表（可能被行数/字节预算截断）" }),
    items: Type.Array(ghHitSchema, { description: "全部命中，不受文本截断影响" }),
  },
  { additionalProperties: false },
);

/** `repos.listReleases` 的一行（REST 字段名）。 */
export const ghReleaseSummarySchema = Type.Object(
  {
    tag_name: Type.String(),
    name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    draft: Type.Optional(Type.Boolean()),
    prerelease: Type.Optional(Type.Boolean()),
    published_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    created_at: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const ghReleaseListPayloadSchema = Type.Object(
  {
    text: Type.String(),
    releases: Type.Array(ghReleaseSummarySchema),
  },
  { additionalProperties: false },
);

/** `actions.listWorkflowRuns*` / `getWorkflowRun` 的共同字段（REST 字段名）。 */
export const ghRunSummarySchema = Type.Object(
  {
    id: Type.Number(),
    name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    display_title: Type.Optional(Type.String()),
    status: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    conclusion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    head_branch: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    event: Type.Optional(Type.String()),
    created_at: Type.Optional(Type.String()),
    updated_at: Type.Optional(Type.String()),
    run_started_at: Type.Optional(Type.String()),
    html_url: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const ghRunListPayloadSchema = Type.Object(
  {
    text: Type.String(),
    runs: Type.Array(ghRunSummarySchema),
  },
  { additionalProperties: false },
);

/** `watch-github-run`：文本是轮询进度与完成报告，载荷是收尾时查到的运行状态。 */
export const ghRunPayloadSchema = Type.Object(
  {
    text: Type.String(),
    run: ghRunSummarySchema,
  },
  { additionalProperties: false },
);

/** `repos.get` 里我们渲染与脚本可能用到的字段（REST 字段名）。 */
export const ghRepoViewSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    full_name: Type.Optional(Type.String()),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    html_url: Type.Optional(Type.String()),
    homepage: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    private: Type.Optional(Type.Boolean()),
    fork: Type.Optional(Type.Boolean()),
    archived: Type.Optional(Type.Boolean()),
    visibility: Type.Optional(Type.String()),
    language: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    default_branch: Type.Optional(Type.String()),
    stargazers_count: Type.Optional(Type.Number()),
    forks_count: Type.Optional(Type.Number()),
    open_issues_count: Type.Optional(Type.Number()),
    license: Type.Optional(
      Type.Union([Type.Object({ name: Type.Optional(Type.String()) }), Type.Null()]),
    ),
    pushed_at: Type.Optional(Type.String()),
    created_at: Type.Optional(Type.String()),
    updated_at: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** `repos.getReleaseByTag` / `getLatestRelease` 里我们渲染与脚本可能用到的字段。 */
export const ghReleaseViewSchema = Type.Object(
  {
    tag_name: Type.Optional(Type.String()),
    name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    html_url: Type.Optional(Type.String()),
    draft: Type.Optional(Type.Boolean()),
    prerelease: Type.Optional(Type.Boolean()),
    created_at: Type.Optional(Type.String()),
    published_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    target_commitish: Type.Optional(Type.String()),
    author: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
    assets: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.Optional(Type.Number()),
            name: Type.Optional(Type.String()),
            size: Type.Optional(Type.Number()),
            download_count: Type.Optional(Type.Number()),
            content_type: Type.Optional(Type.String()),
            state: Type.Optional(Type.String()),
            browser_download_url: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
      ),
    ),
  },
  { additionalProperties: true },
);

export const ghReleaseViewPayloadSchema = Type.Object(
  {
    text: Type.String(),
    release: ghReleaseViewSchema,
  },
  { additionalProperties: false },
);

/** `repos.get` 的载荷：文本 + REST 响应。 */
export const ghRepoPayloadSchema = Type.Object(
  {
    text: Type.String(),
    repo: ghRepoViewSchema,
  },
  { additionalProperties: false },
);

/** `read-github-pr-diff`：文本是原始 diff，载荷是从它解析出的变更统计。 */
export const ghDiffPayloadSchema = Type.Object(
  {
    text: Type.String(),
    files: Type.Array(
      Type.Object(
        {
          path: Type.String(),
          additions: Type.Number(),
          deletions: Type.Number(),
          /** diff 里的旧路径，重命名/复制时与 `path` 不同。 */
          oldPath: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    additions: Type.Number(),
    deletions: Type.Number(),
    changedFiles: Type.Number(),
  },
  { additionalProperties: false },
);
