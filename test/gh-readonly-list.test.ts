/**
 * Tests for the gh-readonly browse argv builder (`listGithubArgs`).
 *
 * Browse calls (no keywords) keep `gh issue list` / `gh pr list` semantics.
 * Keyword searches are handled by the octokit-based client in
 * `src/lib/github.ts` instead — see `test/github-search.test.ts` for that path.
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
    // browse keeps the full pr list state set (merged is a gh list value)
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

  it("appends structured filters for browse", () => {
    expect(
      listGithubArgs("issue", {
        repo: "a/b",
        state: "all",
        label: "bug",
        author: "trim21",
        assignee: "@me",
        milestone: "v1",
        limit: 10,
      }),
    ).toEqual([
      "issue",
      "list",
      "--repo",
      "a/b",
      "--state",
      "all",
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

  it("searches across GitHub when no repo is given", () => {
    expect(listGithubArgs("issue", {})).toEqual(["issue", "list"]);
  });
});
