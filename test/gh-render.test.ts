/**
 * 文本类 gh 工具的渲染器（src/gh/render.ts）：文本格式与 diff 统计解析。
 * 这些函数是「文本与载荷同源」的那一半——JSON 进、文本出，载荷直接用 JSON。
 */
import { describe, expect, it } from "vitest";

import {
  parseDiffStats,
  renderReleaseList,
  renderReleaseView,
  renderRepoView,
  renderRunList,
} from "../src/gh/render.js";

describe("gh 渲染器", () => {
  it("release 列表：tag、标记、日期、标题", () => {
    expect(
      renderReleaseList([
        {
          tag_name: "v2.102.0",
          name: "GitHub CLI 2.102.0",
          latest: true,
          prerelease: false,
          draft: false,
          published_at: "2026-09-30T02:40:02Z",
        },
        {
          tag_name: "v2.103.0-rc.1",
          name: "RC",
          latest: false,
          prerelease: true,
          draft: true,
          published_at: null,
        },
      ]),
    ).toBe(
      "v2.102.0\tlatest\t2026-09-30\tGitHub CLI 2.102.0\nv2.103.0-rc.1\tprerelease,draft\t\tRC",
    );
    expect(renderReleaseList([])).toBe("(no releases)");
  });

  it("运行列表：id、状态、结论、工作流、分支、事件、日期、链接", () => {
    expect(
      renderRunList([
        {
          id: 37131067543,
          status: "completed",
          conclusion: "success",
          name: "CI",
          head_branch: "master",
          event: "push",
          created_at: "2026-10-03T14:50:27Z",
          html_url: "https://example.test/run/1",
        },
      ]),
    ).toBe(
      "37131067543\tcompleted\tsuccess\tCI\tmaster\tpush\t2026-10-03\thttps://example.test/run/1",
    );
    expect(renderRunList([])).toBe("(no workflow runs)");
  });

  it("仓库概览：标题、事实、链接、日期与许可", () => {
    expect(
      renderRepoView({
        full_name: "trim21/pi-extensions",
        description: "pi extensions",
        html_url: "https://github.com/trim21/pi-extensions",
        visibility: "public",
        language: "TypeScript",
        default_branch: "master",
        stargazers_count: 3,
        forks_count: 0,
        open_issues_count: 3,
        license: { name: "MIT License" },
        pushed_at: "2026-10-03T14:50:26Z",
        created_at: "2026-06-20T10:09:24Z",
      }),
    ).toBe(
      [
        "trim21/pi-extensions — pi extensions",
        "public · TypeScript · default branch master · stars 3 · forks 0 · open issues 3",
        "https://github.com/trim21/pi-extensions",
        "pushed 2026-10-03 · created 2026-06-20 · MIT License",
      ].join("\n"),
    );
  });

  it("release 详情：元信息、资产清单、正文", () => {
    expect(
      renderReleaseView({
        tag_name: "v2.102.0",
        name: "GitHub CLI 2.102.0",
        html_url: "https://example.test/release",
        latest: true,
        published_at: "2026-09-30T02:40:02Z",
        author: { login: "github-actions" },
        assets: [{ name: "checksums.txt", size: 1971, download_count: 27528 }],
        body: "# Notes\n",
      }),
    ).toBe(
      [
        "v2.102.0 — GitHub CLI 2.102.0",
        "published 2026-09-30 · by github-actions · https://example.test/release",
        "assets (1):",
        "- checksums.txt 1971 bytes, 27528 downloads",
        "",
        "# Notes",
      ].join("\n"),
    );
  });

  it("diff 统计：新增、修改、删除、重命名与二进制文件", () => {
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
