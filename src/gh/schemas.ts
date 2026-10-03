/**
 * gh-readonly 工具的结构化结果 schema（TypeBox）。
 *
 * 两个用途：codemode 脚本侧据此渲染 `call()` 的返回类型；工具总线在运行期用它复核
 * `structuredResult.value`。因此 schema 必须**允许额外字段**（GitHub 的 JSON 只多不少，
 * 多出来的字段不该让工具失败），只对工具本身已经依赖的字段设 required。
 *
 * 字段名取自 GitHub 的两种传输：`gh ... view --json`（GraphQL，actor 叫 `author` /
 * `user`）与 REST（`/pulls/:n/comments` 等，用了 `diff_hunk` / `submitted_at` 这类
 * 下划线命名）。评论与评审条目因此放宽成两者的并集。
 */

import { Type } from "typebox";

// ── 共享片段 ─────────────────────────────────────────────────────────────────

/** GitHub 的 actor（author / assignee / mergedBy / review 作者）。 */
export const ghActorSchema = Type.Object({
  login: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  is_bot: Type.Optional(Type.Boolean()),
});

export const ghLabelSchema = Type.Object({
  name: Type.String(),
  color: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

export const ghMilestoneSchema = Type.Object({
  title: Type.String(),
  number: Type.Optional(Type.Number()),
  dueOn: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/** 评论条目：GraphQL 的 `author`/`createdAt` 与 REST 的 `user`/`diff_hunk` 并集。 */
export const ghCommentSchema = Type.Object({
  id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  body: Type.Optional(Type.String()),
  author: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  user: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  path: Type.Optional(Type.String()),
  line: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  diff_hunk: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
});

/** 评审条目：GraphQL 的 `reviews` 与 REST 的 `/pulls/:n/reviews` 并集。 */
export const ghReviewSchema = Type.Object({
  id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  body: Type.Optional(Type.String()),
  author: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  user: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  state: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()),
  submitted_at: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
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

/** `read-github-issue`：`gh issue view --json` 的输出。 */
export const issueViewSchema = Type.Object({
  number: Type.Number(),
  title: Type.String(),
  state: Type.String(),
  body: Type.Optional(Type.String()),
  author: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  createdAt: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.String()),
  closedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  url: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Array(ghLabelSchema)),
  assignees: Type.Optional(Type.Array(ghActorSchema)),
  comments: Type.Optional(Type.Array(ghCommentSchema)),
  milestone: Type.Optional(Type.Union([ghMilestoneSchema, Type.Null()])),
});

/** `read-github-pr`：`gh pr view --json` 的输出，比 issue 多出合并与 diff 统计。 */
export const prViewSchema = Type.Object({
  number: Type.Number(),
  title: Type.String(),
  state: Type.String(),
  body: Type.Optional(Type.String()),
  author: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  createdAt: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.String()),
  closedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  mergedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  mergedBy: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
  headRefName: Type.Optional(Type.String()),
  baseRefName: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  additions: Type.Optional(Type.Number()),
  deletions: Type.Optional(Type.Number()),
  changedFiles: Type.Optional(Type.Number()),
  labels: Type.Optional(Type.Array(ghLabelSchema)),
  assignees: Type.Optional(Type.Array(ghActorSchema)),
  reviewRequests: Type.Optional(Type.Array(ghReviewRequestSchema)),
  reviews: Type.Optional(Type.Array(ghReviewSchema)),
  comments: Type.Optional(Type.Array(ghCommentSchema)),
  milestone: Type.Optional(Type.Union([ghMilestoneSchema, Type.Null()])),
});

/** `read-github-issue-comments`：`gh issue view --json comments`。 */
export const issueCommentsSchema = Type.Object({
  comments: Type.Array(ghCommentSchema),
});

/**
 * `read-github-pr-comments`：默认模式是 `gh pr view --json comments`（只有 comments），
 * `reviews: true` 时走 REST 同时给出 reviews 与行内评论。两个字段都可选。
 */
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

/** `gh release list --json` 的一行。 */
export const ghReleaseSummarySchema = Type.Object(
  {
    tagName: Type.String(),
    name: Type.Optional(Type.String()),
    isLatest: Type.Optional(Type.Boolean()),
    isPrerelease: Type.Optional(Type.Boolean()),
    isDraft: Type.Optional(Type.Boolean()),
    publishedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    createdAt: Type.Optional(Type.String()),
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

/** `gh run list` / `gh run view --json` 的共同字段。 */
export const ghRunSummarySchema = Type.Object(
  {
    databaseId: Type.Number(),
    displayTitle: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    conclusion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    workflowName: Type.Optional(Type.String()),
    headBranch: Type.Optional(Type.String()),
    event: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.String()),
    updatedAt: Type.Optional(Type.String()),
    startedAt: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
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

/** `watch-github-run`：文本是 `gh run watch` 的输出，载荷是收尾时查到的运行状态。 */
export const ghRunPayloadSchema = Type.Object(
  {
    text: Type.String(),
    run: ghRunSummarySchema,
  },
  { additionalProperties: false },
);

/** `gh repo view --json` 里我们渲染与脚本可能用到的字段。 */
export const ghRepoViewSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    nameWithOwner: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    homepageUrl: Type.Optional(Type.String()),
    visibility: Type.Optional(Type.String()),
    isPrivate: Type.Optional(Type.Boolean()),
    isFork: Type.Optional(Type.Boolean()),
    isArchived: Type.Optional(Type.Boolean()),
    stargazerCount: Type.Optional(Type.Number()),
    forkCount: Type.Optional(Type.Number()),
    primaryLanguage: Type.Optional(
      Type.Union([
        Type.Object({ name: Type.String() }, { additionalProperties: true }),
        Type.Null(),
      ]),
    ),
    defaultBranchRef: Type.Optional(
      Type.Union([
        Type.Object({ name: Type.String() }, { additionalProperties: true }),
        Type.Null(),
      ]),
    ),
    licenseInfo: Type.Optional(
      Type.Union([
        Type.Object({ name: Type.String() }, { additionalProperties: true }),
        Type.Null(),
      ]),
    ),
    issues: Type.Optional(
      Type.Union([
        Type.Object({ totalCount: Type.Number() }, { additionalProperties: true }),
        Type.Null(),
      ]),
    ),
    pullRequests: Type.Optional(
      Type.Union([
        Type.Object({ totalCount: Type.Number() }, { additionalProperties: true }),
        Type.Null(),
      ]),
    ),
    pushedAt: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.String()),
    updatedAt: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const ghRepoPayloadSchema = Type.Object(
  {
    text: Type.String(),
    repo: ghRepoViewSchema,
  },
  { additionalProperties: false },
);

/** `gh release view --json` 里我们渲染与脚本可能用到的字段。 */
export const ghReleaseViewSchema = Type.Object(
  {
    tagName: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    isDraft: Type.Optional(Type.Boolean()),
    isPrerelease: Type.Optional(Type.Boolean()),
    createdAt: Type.Optional(Type.String()),
    publishedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    targetCommitish: Type.Optional(Type.String()),
    author: Type.Optional(Type.Union([ghActorSchema, Type.Null()])),
    assets: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.Optional(Type.String()),
            size: Type.Optional(Type.Number()),
            downloadCount: Type.Optional(Type.Number()),
            contentType: Type.Optional(Type.String()),
            state: Type.Optional(Type.String()),
            url: Type.Optional(Type.String()),
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
