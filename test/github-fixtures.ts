/**
 * Record/replay the GitHub API for tests, so a test that exercises the octokit
 * clients never depends on the network (and never spies on `globalThis.fetch`).
 *
 *   const api = githubCassette({ "pulls/137": "pull.json", ... });
 *   const client = new GhClient(api.fetch);
 *
 * Replay is the default: the recorded response is read from
 * `test/fixtures/github/<file>`; a request no route matches fails the test, and
 * so does a route whose recording is missing.
 *
 * Record with `RECORD_GITHUB=1 pnpm exec vitest run <file>`: the request is then
 * made for real (needs `gh auth login` and network — the octokit client under
 * test puts its own auth headers on the request) and the JSON body is written to
 * the fixture. Recording is the same code path as replaying, so a fixture cannot
 * drift from what the client reads: re-record whenever a client starts reading a
 * new field. Recordings are redacted (no token ever reaches the repository), and
 * recording authenticates with `GH_TOKEN` / `GITHUB_TOKEN` or the system `gh`.
 *
 * Routes may also carry an inline body, for cases that have nothing to record
 * (paging the recorded jobs into two pages, say).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FIXTURE_DIR = new URL("fixtures/github/", import.meta.url);

const RECORD = process.env.RECORD_GITHUB === "1";

/** Read one recorded response directly (for cases the cassette does not serve). */
export function readFixture<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), "utf8")) as T;
}

/**
 * One route: a fixture file name, or an inline body. `headers` cover what a
 * body cannot express (a pagination `link`, say) — for a recorded route the body
 * still comes from the fixture.
 */
export type FixtureRoute =
  | string
  | { file: string; headers?: Record<string, string> }
  | { body: unknown; headers?: Record<string, string> };

/** URL substring → route. The first matching entry wins, so order them. */
export type FixtureRoutes = Record<string, FixtureRoute>;

export interface GithubCassette {
  fetch: typeof globalThis.fetch;
  /** Every requested URL, in order. */
  calls: string[];
  /**
   * The response body served for a route key in this run — the same data in
   * both modes, so assertions never read fixtures at module scope (recording a
   * missing fixture would otherwise make the test file fail to load).
   */
  body<T>(match: string): T;
  /** Route keys that no request matched — a stale route table. */
  unused(): string[];
}

/**
 * A JSON response carrying its URL, like a real fetch response does: octokit's
 * paginate reads `response.url` while normalizing a list payload.
 */
function jsonResponse(url: string, body: unknown, headers: Record<string, string> = {}): Response {
  const response = Response.json(body, { status: 200, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function fixtureFile(file: string): URL {
  return new URL(file, FIXTURE_DIR);
}

/**
 * The token recording authenticates with: `GH_TOKEN` / `GITHUB_TOKEN` if set,
 * otherwise the system `gh` CLI. The client under test uses the stubbed
 * `gh auth token` output, which the API rejects (401), so the recorder has to
 * supply a real one itself — and it falls back to an unauthenticated request
 * (public data only) when neither is available.
 */
function recordingToken(): string | undefined {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv?.trim()) {
    return fromEnv.trim();
  }
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recordings are committed, so nothing secret may end up in one: the token we
 * sent is redacted, and so is anything shaped like a GitHub token (a response
 * echoing a different credential, say).
 */
function redact(json: string, token: string | undefined): string {
  let out = json;
  if (token) {
    out = out.split(token).join("REDACTED");
  }
  return out.replaceAll(
    /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    "REDACTED",
  );
}

/** Write the response body to the fixture and answer with it. */
async function record(
  url: string,
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
  file: string,
): Promise<unknown> {
  const token = recordingToken();
  const auth = new Headers(init?.headers);
  if (token) {
    auth.set("authorization", `token ${token}`);
  } else {
    auth.delete("authorization");
  }

  const response = await globalThis.fetch(input, { ...init, headers: auth });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `recording ${file} failed: HTTP ${String(response.status)} ${text.slice(0, 200)}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`recording ${file} failed: response is not JSON (${url})`);
  }
  writeFileSync(fixtureFile(file), redact(`${JSON.stringify(body, null, 2)}\n`, token));
  process.stderr.write(`[github-cassette] recorded ${file} <- ${url}\n`);
  return body;
}

/** A `fetch` that replays recorded responses (or records them under RECORD_GITHUB=1). */
export function githubCassette(routes: FixtureRoutes): GithubCassette {
  const calls: string[] = [];
  const used = new Set<string>();
  const served = new Map<string, unknown>();

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    calls.push(url);

    for (const [match, route] of Object.entries(routes)) {
      if (!url.includes(match)) {
        continue;
      }
      used.add(match);

      const file = typeof route === "string" ? route : "file" in route ? route.file : undefined;
      const headers = typeof route === "string" ? {} : (route.headers ?? {});

      let body: unknown;
      if (file === undefined) {
        body = (route as { body: unknown }).body;
      } else if (RECORD) {
        const recorded = await record(url, input, init, file);
        body = recorded;
      } else {
        let raw: string;
        try {
          raw = readFileSync(fixtureFile(file), "utf8");
        } catch {
          throw new Error(
            `no recording for ${url} (expected test/fixtures/github/${file}); record it with RECORD_GITHUB=1`,
          );
        }
        body = JSON.parse(raw) as unknown;
      }

      served.set(match, body);
      return jsonResponse(url, body, headers);
    }

    throw new Error(`unexpected request, no fixture route: ${url}`);
  };

  return {
    fetch,
    calls,
    body: <T>(match: string): T => {
      if (!served.has(match)) {
        throw new Error(`route ${match} was never served — check the route table`);
      }
      return served.get(match) as T;
    },
    unused: () => Object.keys(routes).filter((key) => !used.has(key)),
  };
}
