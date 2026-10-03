/**
 * 文本类 gh 工具改走 `--json` 之后的渲染器：同一份 JSON 既渲染成给模型看的文本，也原样
 * 进结构化载荷。文本格式是我们自己的（不再是 gh 的表格），因此这些函数要稳定、好读，
 * 且只依赖 schema 里声明过的字段。
 */

import { dateOnly } from "../lib/github.js";

/** 一行一个 release：`tag  标记  发布日期  标题`。 */
export function renderReleaseList(
  releases: {
    tagName: string;
    name?: string;
    isLatest?: boolean;
    isPrerelease?: boolean;
    isDraft?: boolean;
    publishedAt?: string | null;
  }[],
): string {
  if (releases.length === 0) {
    return "(no releases)";
  }
  return releases
    .map((release) => {
      const flags = [
        release.isLatest ? "latest" : "",
        release.isPrerelease ? "prerelease" : "",
        release.isDraft ? "draft" : "",
      ].filter(Boolean);
      return [
        release.tagName,
        flags.join(","),
        dateOnly(release.publishedAt),
        release.name ?? "",
      ].join("\t");
    })
    .join("\n");
}

/** 一行一个运行：`id  状态  结论  工作流  分支  事件  创建时间  链接`。 */
export function renderRunList(
  runs: {
    databaseId: number;
    status?: string;
    conclusion?: string | null;
    workflowName?: string;
    headBranch?: string;
    event?: string;
    createdAt?: string;
    url?: string;
  }[],
): string {
  if (runs.length === 0) {
    return "(no workflow runs)";
  }
  return runs
    .map((run) =>
      [
        String(run.databaseId),
        run.status ?? "",
        run.conclusion ?? "",
        run.workflowName ?? "",
        run.headBranch ?? "",
        run.event ?? "",
        dateOnly(run.createdAt),
        run.url ?? "",
      ].join("\t"),
    )
    .join("\n");
}

/** 仓库概览：标题行 + 一行事实 + 一行链接 + 一行日期/许可。 */
export function renderRepoView(repo: {
  nameWithOwner?: string;
  description?: string;
  url?: string;
  visibility?: string;
  primaryLanguage?: { name: string } | null;
  defaultBranchRef?: { name: string } | null;
  stargazerCount?: number;
  forkCount?: number;
  issues?: { totalCount: number } | null;
  pullRequests?: { totalCount: number } | null;
  licenseInfo?: { name: string } | null;
  pushedAt?: string;
  createdAt?: string;
}): string {
  const facts = [
    repo.visibility?.toLowerCase(),
    repo.primaryLanguage?.name,
    repo.defaultBranchRef && `default branch ${repo.defaultBranchRef.name}`,
    repo.stargazerCount !== undefined && `stars ${repo.stargazerCount}`,
    repo.forkCount !== undefined && `forks ${repo.forkCount}`,
    repo.issues && `open issues ${repo.issues.totalCount}`,
    repo.pullRequests && `open PRs ${repo.pullRequests.totalCount}`,
  ].filter(Boolean);
  return [
    [repo.nameWithOwner, repo.description].filter(Boolean).join(" — "),
    facts.join(" · "),
    repo.url ?? "",
    [
      repo.pushedAt && `pushed ${dateOnly(repo.pushedAt)}`,
      repo.createdAt && `created ${dateOnly(repo.createdAt)}`,
      repo.licenseInfo?.name,
    ]
      .filter(Boolean)
      .join(" · "),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** release 详情：标题、事实、资产清单、正文。 */
export function renderReleaseView(release: {
  tagName?: string;
  name?: string;
  url?: string;
  isLatest?: boolean;
  isPrerelease?: boolean;
  isDraft?: boolean;
  publishedAt?: string | null;
  createdAt?: string;
  author?: { login?: string } | null;
  assets?: { name?: string; size?: number; downloadCount?: number }[];
  body?: string;
}): string {
  const flags = [
    release.isLatest && "latest",
    release.isPrerelease && "prerelease",
    release.isDraft && "draft",
  ]
    .filter(Boolean)
    .join(",");
  const assets = release.assets ?? [];
  const lines = [
    [release.tagName, release.name].filter(Boolean).join(" — "),
    [
      `published ${dateOnly(release.publishedAt ?? release.createdAt)}`,
      flags,
      release.author?.login && `by ${release.author.login}`,
      release.url,
    ]
      .filter(Boolean)
      .join(" · "),
  ];
  if (assets.length > 0) {
    lines.push(`assets (${assets.length}):`);
    for (const asset of assets) {
      lines.push(
        `- ${asset.name ?? ""} ${asset.size ?? 0} bytes, ${asset.downloadCount ?? 0} downloads`,
      );
    }
  }
  const body = release.body?.trim() ?? "";
  if (body !== "") {
    lines.push("", body);
  }
  return lines.join("\n");
}

export interface DiffFileStat {
  path: string;
  additions: number;
  deletions: number;
  oldPath?: string;
}

export interface DiffStats {
  files: DiffFileStat[];
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** diff 里的路径：去掉 `a/` / `b/` 前缀与 git 给带空格路径加的双引号；`/dev/null` 给空串。 */
function stripDiffPrefix(raw: string): string {
  const trimmed = raw.trimEnd();
  if (trimmed === "/dev/null") {
    return "";
  }
  return trimmed
    .replace(/^[ab]\//, "")
    .replace(/^"/, "")
    .replace(/"$/, "");
}

/** `diff --git a/x b/y` 的两个路径（路径带空格时 git 会加双引号）。 */
function parseDiffHeader(rest: string): { oldPath: string; newPath: string } | undefined {
  const match = /^(?:"a\/(.+)"|a\/(\S+)) (?:"b\/(.+)"|b\/(\S+))$/.exec(rest.trim());
  if (!match) {
    return undefined;
  }
  // 两组可选路径各有一个未参与匹配的捕获组（运行期是 undefined，类型上是 string），用 `||`
  return { oldPath: match[1] || match[2], newPath: match[3] || match[4] };
}

/**
 * 从 unified diff 文本里解析变更统计。
 *
 * `gh pr diff` 没有 `--json`，因此载荷只能从这里来。解析的边界都是 diff 的结构标记
 * （`diff --git` / `---` / `+++` / `@@`），不依赖具体语言或文件内容：二进制文件与纯
 * 模式变更（没有 `---` / `+++`）按 0 行变更计，路径取自 `diff --git` 头。
 */
export function parseDiffStats(diff: string): DiffStats {
  const files: DiffFileStat[] = [];
  let current: DiffFileStat | undefined;
  /** `--- ` 给出的旧路径，等 `+++ ` 到了再决定它是不是重命名。 */
  let oldPathFromHunk = "";
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        files.push(current);
      }
      const header = parseDiffHeader(line.slice("diff --git ".length));
      current = { path: header?.newPath ?? "", additions: 0, deletions: 0 };
      oldPathFromHunk = header?.oldPath ?? "";
      inHunk = false;
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPathFromHunk = stripDiffPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = stripDiffPrefix(line.slice(4));
      // 删除的文件新路径是 /dev/null，此时用旧路径当 path
      current.path = newPath === "" ? oldPathFromHunk : newPath;
      if (oldPathFromHunk !== "" && oldPathFromHunk !== current.path) {
        current.oldPath = oldPathFromHunk;
      }
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // 文件头（index / mode / rename / Binary files …）不算变更行
      continue;
    }
    if (line.startsWith("+")) {
      current.additions += 1;
    } else if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }
  if (current) {
    files.push(current);
  }

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return { files, additions, deletions, changedFiles: files.length };
}
