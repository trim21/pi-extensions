/**
 * Tests for the web extension:
 * - config: Search1API key resolution
 * - search: request body building, response parsing, result mapping
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSearch1ApiKey } from "../src/web/config.js";
import { buildSearchBody, searchWeb } from "../src/web/search.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function tempHome(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "web-config-test-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return dir;
}

describe("loadSearch1ApiKey", () => {
  it("reads search1apiApiKey from web-search.json", async () => {
    const dir = tempHome({
      "web-search.json": JSON.stringify({ search1apiApiKey: "key-123" }),
    });
    try {
      expect(await loadSearch1ApiKey(join(dir, "web-search.json"))).toBe("key-123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers SEARCH1API_KEY env over file", async () => {
    vi.stubEnv("SEARCH1API_KEY", "env-key");
    const dir = tempHome({
      "web-search.json": JSON.stringify({ search1apiApiKey: "file-key" }),
    });
    try {
      expect(await loadSearch1ApiKey(join(dir, "web-search.json"))).toBe("env-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("returns undefined when file is missing or key absent", async () => {
    expect(await loadSearch1ApiKey("/nonexistent/web-search.json")).toBeUndefined();
    const dir = tempHome({ "web-search.json": "{}" });
    try {
      expect(await loadSearch1ApiKey(join(dir, "web-search.json"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSearchBody", () => {
  it("clamps numResults and defaults crawl_results to 0", () => {
    const body = buildSearchBody("q", {});
    expect(body).toMatchObject({ query: "q", max_results: 5, crawl_results: 0 });
  });

  it("caps numResults at 50", () => {
    expect(buildSearchBody("q", { numResults: 100 }).max_results).toBe(50);
  });

  it("maps recencyFilter and searchService", () => {
    const body = buildSearchBody("q", {
      recencyFilter: "week",
      searchService: "github",
    });
    expect(body).toMatchObject({ time_range: "week", search_service: "github" });
  });

  it("splits domainFilter into include/exclude sites", () => {
    const body = buildSearchBody("q", { domainFilter: ["github.com", "-example.com"] });
    expect(body).toMatchObject({ include_sites: ["github.com"], exclude_sites: ["example.com"] });
  });

  it("sets crawl_results from includeContent, capped at 5", () => {
    expect(buildSearchBody("q", { includeContent: true, numResults: 3 }).crawl_results).toBe(3);
    expect(buildSearchBody("q", { includeContent: true, numResults: 20 }).crawl_results).toBe(5);
  });
});

describe("searchWeb", () => {
  it("posts to Search1API and maps results", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        searchParameters: { query: "q" },
        results: [
          { title: "T1", link: "https://a.example/1", snippet: "S1", content: "C1" },
          { title: "T2", link: "https://a.example/2", snippet: "S2" },
          { title: null, link: null, snippet: null },
          { title: "skip", link: "", snippet: "" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchWeb("q", "key", { numResults: 3 });
    expect(result.hits).toEqual([
      { title: "T1", url: "https://a.example/1", snippet: "S1", content: "C1" },
      { title: "T2", url: "https://a.example/2", snippet: "S2" },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.search1api.com/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key");
    expect(JSON.parse(init.body as string)).toMatchObject({ query: "q", max_results: 3 });
  });

  it("throws on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(searchWeb("q", "key")).rejects.toThrow("Search1API error 500");
  });
});
