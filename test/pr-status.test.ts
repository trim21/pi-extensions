/**
 * Tests for `read-github-pr-status` — it must return the current checks of the
 * PR's head commit immediately, without polling, and each Actions-backed check
 * has to carry the `run_id` / `job_id` that lead to its log.
 *
 * The tool reads through the octokit checks client, so the tests stub the two
 * externals: `gh auth token` (spawn) and the HTTP layer (global fetch).
 *
 * Run: npx vitest run test/pr-status.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import registerTools from "../src/gh-readonly.js";

/** Fake `gh auth token` process. */
class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    return true;
  }
}

interface ToolDef {
  name: string;
  execute: (
    _id: string,
    params: { number: number | string; repo?: string },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: { cwd?: string },
  ) => Promise<{
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
  }>;
}

function getPrStatusExecutor(): ToolDef["execute"] {
  const tools: unknown[] = [];
  const pi = {
    on: () => {},
    registerTool: (t: unknown) => {
      tools.push(t);
      return tools.length;
    },
  };
  registerTools(pi as unknown as Parameters<typeof registerTools>[0]);
  const tool = tools.find(
    (t): t is ToolDef => (t as { name?: string }).name === "read-github-pr-status",
  );
  if (!tool) throw new Error("read-github-pr-status not registered");
  return tool.execute;
}

// gh-readonly 在 Windows 上整体禁用（见 gh-readonly.ts），executor 测试只属于
// 非 Windows 平台；guard 避免模块加载时在 win32 上调用扩展工厂。
const exec = process.platform === "win32" ? undefined : getPrStatusExecutor();
const DEFAULT_PARAMS: { number: number | string; repo?: string } = { number: 7 };
const call = (params: { number: number | string; repo?: string } = DEFAULT_PARAMS) =>
  exec!("id", params, undefined, undefined, { cwd: undefined });

beforeEach(() => {
  spawnMock.mockImplementation(() => {
    const proc = new FakeChildProcess();
    setImmediate(() => {
      proc.stdout.write("test-token\n");
      proc.emit("close", 0);
    });
    return proc;
  });
});

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

const HEAD_SHA = "9f1c0dd3a5c1c1e0d3f5d0b0a1b2c3d4e5f60718";

/** One Actions check run whose details_url points at run 5 / job 10. */
const ACTIONS_CHECK = {
  name: "build",
  status: "completed",
  conclusion: "failure",
  started_at: "2026-09-05T03:12:01Z",
  html_url: "https://github.com/o/r/actions/runs/5/job/10",
  details_url: "https://github.com/o/r/actions/runs/5/job/10",
};

/** One non-Actions check run (no run/job to point at). */
const EXTERNAL_CHECK = {
  name: "release",
  status: "completed",
  conclusion: "success",
  started_at: "2026-09-05T03:10:00Z",
  html_url: "https://example.com/build/9",
  details_url: "https://example.com/build/9",
};

const COMMIT_STATUS = {
  context: "azure/ci",
  state: "failure",
  target_url: "https://dev.azure.com/x/y/_build/results?buildId=1",
};

/**
 * A JSON response that carries its URL like a real fetch response does —
 * octokit's paginate reads `response.url` when it normalizes a list payload.
 */
function jsonResponse(url: string, body: unknown): Response {
  const response = Response.json(body, { status: 200 });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

/** Route the fake HTTP layer by URL and record every request. */
function stubApi(): string[] {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    let body: unknown;
    if (url.includes("/pulls/7")) {
      body = { head: { sha: HEAD_SHA } };
    } else if (url.includes("/commits/" + HEAD_SHA + "/status")) {
      body = { state: "failure", statuses: [COMMIT_STATUS] };
    } else if (url.includes("/commits/" + HEAD_SHA + "/check-runs")) {
      body = { total_count: 2, check_runs: [ACTIONS_CHECK, EXTERNAL_CHECK] };
    } else if (url.includes("/actions/runs?head_sha=" + HEAD_SHA)) {
      body = {
        total_count: 1,
        workflow_runs: [{ id: 5, name: "CI", event: "pull_request", html_url: "https://x" }],
      };
    } else {
      throw new Error(`unexpected request: ${url}`);
    }
    return Promise.resolve(jsonResponse(url, body));
  });
  return calls;
}

describe.skipIf(process.platform === "win32")("read-github-pr-status", () => {
  it("reports every check of the head commit with its run/job ids", async () => {
    stubApi();
    const result = await call({ number: 7, repo: "o/r" });
    const payload = JSON.parse(result.content[0].text) as {
      pr: number;
      repo: string;
      head_sha: string;
      checks: Record<string, unknown>[];
    };

    expect(payload.pr).toBe(7);
    expect(payload.repo).toBe("o/r");
    expect(payload.head_sha).toBe(HEAD_SHA);
    expect(payload.checks).toEqual([
      {
        name: "azure/ci",
        bucket: "fail",
        event: null,
        run_id: null,
        job_id: null,
        url: COMMIT_STATUS.target_url,
      },
      {
        name: "build",
        bucket: "fail",
        event: "pull_request",
        run_id: 5,
        job_id: 10,
        url: ACTIONS_CHECK.html_url,
      },
      {
        name: "release",
        bucket: "pass",
        event: null,
        run_id: null,
        job_id: null,
        url: EXTERNAL_CHECK.html_url,
      },
    ]);
  });

  it("returns the snapshot immediately instead of polling", async () => {
    const calls = stubApi();
    await call({ number: 7, repo: "o/r" });

    // one request per read (PR, commit statuses, check runs, run events) — a
    // polling implementation would repeat the check reads until they settle
    expect(calls.filter((url) => url.includes("/check-runs"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("/status"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("/pulls/7"))).toHaveLength(1);
  });

  it("keeps pending checks pending in the snapshot", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/pulls/7"))
        return Promise.resolve(jsonResponse(url, { head: { sha: HEAD_SHA } }));
      if (url.includes("/status")) {
        return Promise.resolve(jsonResponse(url, { state: "pending", statuses: [] }));
      }
      if (url.includes("/check-runs")) {
        return Promise.resolve(
          jsonResponse(url, {
            total_count: 1,
            check_runs: [{ ...ACTIONS_CHECK, status: "in_progress", conclusion: null }],
          }),
        );
      }
      return Promise.resolve(jsonResponse(url, { total_count: 0, workflow_runs: [] }));
    });

    const result = await call({ number: 7, repo: "o/r" });
    const payload = JSON.parse(result.content[0].text) as { checks: { bucket: string }[] };
    expect(payload.checks.map((c) => c.bucket)).toEqual(["pending"]);
  });

  it("rejects a non-numeric PR number instead of asking the API", async () => {
    const calls = stubApi();
    await expect(call({ number: "abc", repo: "o/r" })).rejects.toThrow(/invalid number/);
    expect(calls).toEqual([]);
  });
});
