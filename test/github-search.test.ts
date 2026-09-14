/**
 * Tests for the octokit-based GitHub search client (`src/lib/github.ts`):
 * query building and result rendering. The live search call itself is not
 * exercised here (it needs network + a gh login) — query/rendering logic is.
 *
 * Run: npx vitest run test/github-search.test.ts
 */
import { describe, expect, it } from "vitest";

import { buildSearchQuery, renderHits, SEARCH_FIELDS, type SearchHit } from "../src/lib/github.js";

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    number: 32100,
    state: "merged",
    title: "fix(platform): separate PR reuse",
    url: "https://github.com/a/b/pull/32100",
    repo: "a/b",
    author: "trim21",
    labels: ["bug", "priority-2-high"],
    milestone: "v1",
    assignees: ["octocat"],
    comments: 3,
    createdAt: "2024-11-01",
    updatedAt: "2024-12-06",
    closedAt: "2024-11-05",
    mergedAt: "2024-11-05",
    ...overrides,
  };
}

describe("buildSearchQuery state semantics", () => {
  it("defaults to open (browse parity)", () => {
    expect(buildSearchQuery("issue", {})).toBe("is:issue state:open");
    expect(buildSearchQuery("pr", {})).toBe("is:pr state:open");
  });

  it("state=all applies no state filter", () => {
    expect(buildSearchQuery("issue", { repo: "a/b", state: "all" })).toBe("repo:a/b is:issue");
    expect(buildSearchQuery("pr", { repo: "a/b", state: "all" })).toBe("repo:a/b is:pr");
  });

  it("issue closed maps to state:closed", () => {
    expect(buildSearchQuery("issue", { state: "closed" })).toBe("is:issue state:closed");
  });

  it("pr closed excludes merged PRs", () => {
    expect(buildSearchQuery("pr", { state: "closed" })).toBe("is:pr state:closed -is:merged");
  });

  it("pr merged maps to is:merged", () => {
    expect(buildSearchQuery("pr", { state: "merged" })).toBe("is:pr is:merged");
  });

  it("rejects merged for issue searches", () => {
    expect(() => buildSearchQuery("issue", { state: "merged" })).toThrow(
      "state=merged is only valid for PR searches",
    );
  });

  it("rejects unknown states", () => {
    expect(() => buildSearchQuery("issue", { state: "openn" })).toThrow("invalid state");
  });
});

describe("buildSearchQuery filters", () => {
  it("keeps keywords as free text after the qualifiers", () => {
    expect(buildSearchQuery("issue", { repo: "a/b", keywords: "autoclosed goproxy" })).toBe(
      "repo:a/b is:issue state:open autoclosed goproxy",
    );
  });

  it("passes structured filters through", () => {
    expect(
      buildSearchQuery("issue", {
        repo: "a/b",
        author: "trim21",
        assignee: "octocat",
        milestone: "v1",
      }),
    ).toBe("repo:a/b is:issue state:open author:trim21 assignee:octocat milestone:v1");
  });

  it("quotes qualifier values containing whitespace", () => {
    expect(buildSearchQuery("issue", { label: "help wanted" })).toBe(
      'is:issue state:open label:"help wanted"',
    );
    expect(buildSearchQuery("pr", { milestone: "The big one" })).toBe(
      'is:pr state:open milestone:"The big one"',
    );
  });

  it("does not quote simple qualifier values", () => {
    expect(buildSearchQuery("issue", { label: "bug", assignee: "@me" })).toBe(
      "is:issue state:open label:bug assignee:@me",
    );
  });
});

describe("renderHits", () => {
  it("renders default columns with repo column when no repo is given", () => {
    expect(renderHits([hit()], {})).toBe(
      "a/b\t32100\tmerged\tfix(platform): separate PR reuse\tbug,priority-2-high\t2024-12-06",
    );
  });

  it("drops the repo column when a repo is given", () => {
    expect(renderHits([hit()], { repo: "a/b" })).toBe(
      "32100\tmerged\tfix(platform): separate PR reuse\tbug,priority-2-high\t2024-12-06",
    );
  });

  it("renders the requested fields in order", () => {
    expect(renderHits([hit()], { fields: "number,state,url,author" })).toBe(
      "32100\tmerged\thttps://github.com/a/b/pull/32100\ttrim21",
    );
  });

  it("renders multiple hits as rows", () => {
    const hits = [hit({ number: 1, title: "first" }), hit({ number: 2, title: "second" })];
    expect(renderHits(hits, { fields: "number,title" })).toBe("1\tfirst\n2\tsecond");
  });

  it("throws on unknown fields with the valid list", () => {
    expect(() => renderHits([hit()], { fields: "number,bogus" })).toThrow(
      `unknown field: bogus (valid: ${SEARCH_FIELDS.join(", ")})`,
    );
  });
});
