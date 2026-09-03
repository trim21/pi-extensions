/**
 * Tests for the gh-readonly issue/PR list argv builder (`listGithubArgs`).
 *
 * Regression: keyword searches used to go through `gh issue list --search` /
 * `gh pr list --search`, whose `--state` filter defaults to open — so searches
 * for reports that had been closed or merged came back empty (see renovate
 * session 2026-09-03: list-github-issues returned only open rows while direct
 * `gh search issues` found the closed issues #3981/#42726/#24539). Keyword
 * searches must therefore route through `gh search issues` / `gh search prs`.
 *
 * Run: npx vitest run test/gh-readonly-list.test.ts
 */
import { describe, expect, it } from "vitest";

import { listGithubArgs } from "../src/gh-readonly.js";

describe("listGithubArgs browse path (no keywords)", () => {
  it("defaults to gh issue list in the given repo", () => {
    expect(listGithubArgs("issue", { repo: "a/b" })).toEqual(["issue", "list", "--repo", "a/b"]);
  });

  it("passes browse state through to gh issue list / pr list", () => {
    expect(listGithubArgs("issue", { repo: "a/b", state: "closed" })).toEqual([
      "issue",
      "list",
      "--repo",
      "a/b",
      "--state",
      "closed",
    ]);
    // browse keeps the full pr list state set (merged is not a gh search state)
    expect(listGithubArgs("pr", { repo: "a/b", state: "merged" })).toEqual([
      "pr",
      "list",
      "--repo",
      "a/b",
      "--state",
      "merged",
    ]);
  });

  it("omits state when browsing defaults are desired", () => {
    expect(listGithubArgs("pr", { repo: "a/b" })).toEqual(["pr", "list", "--repo", "a/b"]);
  });
});

describe("listGithubArgs keyword search path", () => {
  it("routes keyword searches through gh search issues with --repo", () => {
    expect(
      listGithubArgs("issue", { repo: "renovatebot/renovate", keywords: "autoclosed" }),
    ).toEqual([
      "search",
      "issues",
      "--repo",
      "renovatebot/renovate",
      "autoclosed",
      "--state",
      "open",
    ]);
  });

  it("searches across GitHub when no repo is given", () => {
    expect(listGithubArgs("issue", { keywords: "autoclosed" })).toEqual([
      "search",
      "issues",
      "autoclosed",
      "--state",
      "open",
    ]);
  });

  it("state=all drops the state filter so closed issues are included", () => {
    expect(listGithubArgs("issue", { repo: "a/b", keywords: "kw", state: "all" })).toEqual([
      "search",
      "issues",
      "--repo",
      "a/b",
      "kw",
    ]);
  });

  it("state=closed restricts the search to closed issues", () => {
    expect(listGithubArgs("issue", { repo: "a/b", keywords: "kw", state: "closed" })).toEqual([
      "search",
      "issues",
      "--repo",
      "a/b",
      "kw",
      "--state",
      "closed",
    ]);
  });

  it("maps state=merged to --merged for PR search", () => {
    expect(listGithubArgs("pr", { repo: "a/b", keywords: "kw", state: "merged" })).toEqual([
      "search",
      "prs",
      "--repo",
      "a/b",
      "kw",
      "--merged",
    ]);
  });

  it("maps state=all for PR search to an unfiltered query", () => {
    expect(listGithubArgs("pr", { repo: "a/b", keywords: "kw", state: "all" })).toEqual([
      "search",
      "prs",
      "--repo",
      "a/b",
      "kw",
    ]);
  });

  it("appends structured filters after the keywords", () => {
    expect(
      listGithubArgs("issue", {
        repo: "a/b",
        keywords: "kw",
        label: "bug",
        author: "trim21",
        assignee: "@me",
        milestone: "v1",
        limit: 10,
      }),
    ).toEqual([
      "search",
      "issues",
      "--repo",
      "a/b",
      "kw",
      "--state",
      "open",
      "--label",
      "bug",
      "--author",
      "trim21",
      "--assignee",
      "@me",
      "--milestone",
      "v1",
      "--limit",
      "10",
    ]);
  });
});
