/**
 * `read-github-pr-diff` 的变更统计：从 unified diff 文本解析出每个文件的增删行数。
 *
 * 解析的边界都是 diff 的结构标记（`diff --git` / `---` / `+++` / `@@`），不依赖具体语言
 * 或文件内容：二进制文件与纯模式变更（没有 `---` / `+++`）按 0 行变更计，路径取自
 * `diff --git` 头。
 */

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
