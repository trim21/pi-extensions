/**
 * 文本类 gh 工具改走 `--json` 之后的渲染器：同一份 JSON 既渲染成给模型看的文本，也原样
 * 进结构化载荷。文本格式是我们自己的（不再是 gh 的表格），因此这些函数要稳定、好读，
 * 且只依赖 schema 里声明过的字段。
 */

import { dateOnly } from "../lib/github.js";

/**
 * 一行一个 release：`tag  标记  发布日期  标题`。
 *
 * 标记有 `latest`（该仓库最新发布）/ `prerelease` / `draft`；REST 没有「isLatest」字段
 * （那是 gh 按列表顺序算的），所以由调用方按第一个非 draft/prerelease 的条目传进来。
 */
export function renderReleaseList(
  releases: {
    tag_name: string;
    name?: string | null;
    latest?: boolean;
    prerelease?: boolean;
    draft?: boolean;
    published_at?: string | null;
  }[],
): string {
  if (releases.length === 0) {
    return "(no releases)";
  }
  return releases
    .map((release) => {
      const flags = [
        release.latest ? "latest" : "",
        release.prerelease ? "prerelease" : "",
        release.draft ? "draft" : "",
      ].filter(Boolean);
      return [
        release.tag_name,
        flags.join(","),
        dateOnly(release.published_at),
        release.name ?? "",
      ].join("\t");
    })
    .join("\n");
}

/** 一行一个运行：`id  状态  结论  工作流  分支  事件  创建时间  链接`。 */
export function renderRunList(
  runs: {
    id: number;
    status?: string | null;
    conclusion?: string | null;
    name?: string | null;
    head_branch?: string | null;
    event?: string;
    created_at?: string;
    html_url?: string;
  }[],
): string {
  if (runs.length === 0) {
    return "(no workflow runs)";
  }
  return runs
    .map((run) =>
      [
        String(run.id),
        run.status ?? "",
        run.conclusion ?? "",
        run.name ?? "",
        run.head_branch ?? "",
        run.event ?? "",
        dateOnly(run.created_at),
        run.html_url ?? "",
      ].join("\t"),
    )
    .join("\n");
}

/** 仓库概览：标题行 + 一行事实 + 一行链接 + 一行日期/许可。 */
export function renderRepoView(repo: {
  full_name?: string;
  description?: string | null;
  html_url?: string;
  visibility?: string;
  language?: string | null;
  default_branch?: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  license?: { name?: string } | null;
  pushed_at?: string;
  created_at?: string;
}): string {
  const facts = [
    repo.visibility?.toLowerCase(),
    repo.language,
    repo.default_branch && `default branch ${repo.default_branch}`,
    repo.stargazers_count !== undefined && `stars ${repo.stargazers_count}`,
    repo.forks_count !== undefined && `forks ${repo.forks_count}`,
    repo.open_issues_count !== undefined && `open issues ${repo.open_issues_count}`,
  ].filter(Boolean);
  return [
    [repo.full_name, repo.description].filter(Boolean).join(" — "),
    facts.join(" · "),
    repo.html_url ?? "",
    [
      repo.pushed_at && `pushed ${dateOnly(repo.pushed_at)}`,
      repo.created_at && `created ${dateOnly(repo.created_at)}`,
      repo.license?.name,
    ]
      .filter(Boolean)
      .join(" · "),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** release 详情：标题、事实、资产清单、正文。 */
export function renderReleaseView(release: {
  tag_name?: string;
  name?: string | null;
  html_url?: string;
  /** 由调用方按「列表里第一个非 draft / prerelease」推断（REST 没有这个字段）。 */
  latest?: boolean;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string | null;
  created_at?: string;
  author?: { login?: string } | null;
  assets?: { name?: string; size?: number; download_count?: number }[];
  body?: string | null;
}): string {
  const flags = [release.prerelease && "prerelease", release.draft && "draft"]
    .filter(Boolean)
    .join(",");
  const assets = release.assets ?? [];
  const lines = [
    [release.tag_name, release.name].filter(Boolean).join(" — "),
    [
      `published ${dateOnly(release.published_at ?? release.created_at)}`,
      flags,
      release.author?.login && `by ${release.author.login}`,
      release.html_url,
    ]
      .filter(Boolean)
      .join(" · "),
  ];
  if (assets.length > 0) {
    lines.push(`assets (${assets.length}):`);
    for (const asset of assets) {
      lines.push(
        `- ${asset.name ?? ""} ${asset.size ?? 0} bytes, ${asset.download_count ?? 0} downloads`,
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
