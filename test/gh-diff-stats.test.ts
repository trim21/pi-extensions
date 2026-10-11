/**
 * `read-github-pr-diff` 的变更统计：从 unified diff 文本解析出每个文件的增删行数
 * （`src/gh/diff-stats.ts`）。
 */
import { describe, expect, it } from "vitest";

import { parseDiffStats } from "../src/gh/diff-stats.js";

describe("parseDiffStats", () => {
  it("新增、修改、删除、重命名与二进制文件", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,3 @@",
      "+one",
      "+two",
      "+three",
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-gone",
      "-also gone",
      "diff --git a/docs/readme.md b/docs/readme.md",
      "index 2222222..3333333 100644",
      "--- a/docs/readme.md",
      "+++ b/docs/readme.md",
      "@@ -1,2 +1,1 @@",
      "-before",
      "+after",
      "diff --git a/img.png b/img.png",
      "index 4444444..5555555 100644",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/old-name.ts b/new-name.ts",
      "similarity index 90%",
      "rename from old-name.ts",
      "rename to new-name.ts",
      "index 6666666..7777777 100644",
      "--- a/old-name.ts",
      "+++ b/new-name.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+added",
    ].join("\n");

    expect(parseDiffStats(diff)).toEqual({
      files: [
        { path: "src/new.ts", additions: 3, deletions: 0 },
        { path: "src/old.ts", additions: 0, deletions: 2 },
        { path: "docs/readme.md", additions: 1, deletions: 1 },
        { path: "img.png", additions: 0, deletions: 0 },
        { path: "new-name.ts", additions: 1, deletions: 0, oldPath: "old-name.ts" },
      ],
      additions: 5,
      deletions: 3,
      changedFiles: 5,
    });
  });
});
