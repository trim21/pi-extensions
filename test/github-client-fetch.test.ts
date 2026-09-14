/**
 * Regression test for the octokit `request.fetch` plumbing in
 * `src/lib/github.ts`: octokit v5 has no `agent` option, so the proxy reaches
 * the search/checks clients as a custom fetch. These tests pin down that the
 * injected fetch is the one performing the request (and that the default path
 * still uses the global fetch) without touching the network.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { createGithubSearch } from "../src/lib/github.js";

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    return true;
  }
}

/** Make `gh auth token` resolve with a token so the octokit client can be built. */
function stubAuthToken(): void {
  spawnMock.mockImplementation(() => {
    const proc = new FakeChildProcess();
    setImmediate(() => {
      proc.stdout.write("test-token\n");
      proc.emit("close", 0);
    });
    return proc;
  });
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(body: unknown): Response {
  return Response.json(body, { status: 200 });
}

const RAW_ITEM = {
  number: 7,
  state: "closed",
  title: "proxied search",
  html_url: "https://github.com/a/b/pull/7",
  repository_url: "https://api.github.com/repos/a/b",
  user: { login: "octocat" },
  labels: [],
  milestone: null,
  assignees: [],
  comments: 0,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  closed_at: "2024-01-03T00:00:00Z",
  pull_request: { merged_at: "2024-01-03T00:00:00Z" },
};

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe("createGithubSearch fetch injection", () => {
  it("performs octokit requests through the injected fetch", async () => {
    stubAuthToken();
    type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;
    const calls: { url: string; headers: FetchInit["headers"] }[] = [];
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      calls.push({ url: requestUrl(input), headers: init?.headers });
      return Promise.resolve(jsonResponse({ items: [RAW_ITEM] }));
    };

    const hits = await createGithubSearch({ fetch: fetchImpl }).search("pr", {
      repo: "a/b",
      keywords: "proxy",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/search/issues");
    expect(calls[0]?.url).toContain("q=repo%3Aa%2Fb");
    // auth still flows through the injected fetch
    expect(calls[0]?.headers).toMatchObject({ authorization: "token test-token" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ number: 7, state: "merged", repo: "a/b" });
  });

  it("falls back to the global fetch when no fetch is injected", async () => {
    stubAuthToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ items: [] }));

    await createGithubSearch().search("issue", { repo: "a/b" });

    expect(spy).toHaveBeenCalledTimes(1);
    const [firstCall] = spy.mock.calls;
    if (!firstCall) throw new Error("global fetch was not called");
    expect(requestUrl(firstCall[0])).toContain("/search/issues");
  });
});
