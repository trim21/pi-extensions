/**
 * Tests for the octokit-based GitHub search client (`src/lib/github.ts`):
 * query building and result rendering. The live search call itself is not
 * exercised here (it needs network + a gh login) — query/rendering logic is.
 *
 * Run: npx vitest run test/github-search.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  buildSearchQuery,
  createGithubApi,
  createGithubSearch,
  renderHits,
  SEARCH_FIELDS,
  type SearchHit,
} from "../src/lib/github.js";

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

/** Serve the given responses in order (the last one repeats); record every requested URL. */
function stubFetch(responses: { status: number; body: unknown }[]): {
  fetch: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const fetchStub = async (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Response.json(response?.body ?? null, {
      status: response?.status ?? 500,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchStub, calls };
}

/** Minimal `/search/issues` item that satisfies the client's response schema. */
const SEARCH_ITEM = {
  number: 12,
  state: "open",
  title: "lsp: derive resolved config from shared client defaults",
  html_url: "https://github.com/a/b/issues/12",
  repository_url: "https://api.github.com/repos/a/b",
  user: { login: "trim21" },
  labels: [],
  milestone: null,
  assignees: [],
  comments: 0,
  created_at: "2024-11-01T00:00:00Z",
  updated_at: "2024-11-02T00:00:00Z",
  closed_at: null,
  pull_request: null,
};

function searchBody(): { total_count: number; incomplete_results: boolean; items: unknown[] } {
  return { total_count: 1, incomplete_results: false, items: [SEARCH_ITEM] };
}

/**
 * 请求走 `api.call`：缓存的 token 失效（401）时丢缓存换新 token 重试一次，而不是
 * 直接把 401 抛给调用方。
 *
 * 注意：octokit 打包的 throttling 对 `/search` 路由有约 2s 的最小间隔（实测：同一
 * 进程里第二次走到该路由要等 ~2s，换成 `/repos` 路由则不会；重试的第二次请求同样
 * 要等），所以本组用例的耗时来自 octokit 自身的节流，不是被测代码变慢。
 */
describe("search 的请求路径", () => {
  it("缓存的 token 失效时换新 token 重试一次", async () => {
    const api = stubFetch([
      { status: 401, body: { message: "Bad credentials" } },
      { status: 200, body: searchBody() },
    ]);
    const search = createGithubSearch(
      createGithubApi({ fetch: api.fetch, token: async () => "test-token" }),
    );

    const hits = await search.search("issue", { repo: "a/b" });

    expect(hits.map((entry) => entry.number)).toEqual([12]);
    expect(api.calls).toHaveLength(2);
  });

  // `@me` 是 gh CLI 的简写：octokit 路径不展开，也不额外发 users.getAuthenticated
  it("带关键词的搜索不展开 @me", async () => {
    const api = stubFetch([{ status: 200, body: searchBody() }]);
    const search = createGithubSearch(
      createGithubApi({ fetch: api.fetch, token: async () => "test-token" }),
    );

    await search.search("issue", { repo: "a/b", assignee: "@me" });

    expect(api.calls).toHaveLength(1);
    expect(decodeURIComponent(api.calls[0] ?? "")).toContain("assignee:@me");
  });
});
