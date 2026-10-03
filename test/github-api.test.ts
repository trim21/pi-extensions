/**
 * `createGithubApi`（`src/lib/github.ts`）：token 单点缓存、octokit 路径的 401 重试、
 * `rawFetch`（二进制/归档下载）的 401 重试与非 2xx 转 `GithubApiError`。
 *
 * 这里不用 cassette：要断言的是「同一次调用序列里响应不同」，所以直接给一个按调用次数
 * 变化的 fetch 桩。
 */
import { describe, expect, it, vi } from "vitest";

import { createGithubApi, GithubApiError, isNotFound } from "../src/lib/github.js";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("createGithubApi", () => {
  it("token 只取一次（client 与 rawFetch 共用）", async () => {
    const token = vi.fn(async () => "test-token");
    const fetchImpl = vi.fn(async () => json({ full_name: "o/r" })) as unknown as typeof fetch;
    const api = createGithubApi({ fetch: fetchImpl, token });

    const first = await api.call((octokit) => octokit.rest.repos.get({ owner: "o", repo: "r" }));
    await api.rawFetch("https://api.github.com/repos/o/r/releases/assets/1");

    expect(first.data).toEqual({ full_name: "o/r" });
    expect(token).toHaveBeenCalledTimes(1);
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(2);
  });

  it("octokit 调用遇到 401 时丢缓存重试一次", async () => {
    const token = vi.fn(async () => "expired");
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? json({ message: "Bad credentials" }, 401) : json({ full_name: "o/r" });
    }) as unknown as typeof fetch;
    const api = createGithubApi({ fetch: fetchImpl, token });

    const response = await api.call((octokit) => octokit.rest.repos.get({ owner: "o", repo: "r" }));

    expect(response.data).toEqual({ full_name: "o/r" });
    // 第二次请求前 token 缓存被丢掉，所以重新取了一次
    expect(token).toHaveBeenCalledTimes(2);
  });

  it("rawFetch 遇到 401 时丢缓存重试一次", async () => {
    const token = vi.fn(async () => "expired");
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? json({ message: "Bad credentials" }, 401) : json({ ok: true });
    }) as unknown as typeof fetch;
    const api = createGithubApi({ fetch: fetchImpl, token });

    const response = await api.rawFetch("https://api.github.com/repos/o/r/zipball/v1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(token).toHaveBeenCalledTimes(2);
  });

  it("octokit 调用失败时抛 GithubApiError，带上状态与工具输入", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ message: "Not Found" }, 404),
    ) as unknown as typeof fetch;
    const api = createGithubApi({ fetch: fetchImpl, token: async () => "test-token" });

    const thrown: unknown = await api
      .call((octokit) => octokit.rest.repos.get({ owner: "o", repo: "r" }), { number: 7 })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GithubApiError);
    expect((thrown as GithubApiError).status).toBe(404);
    expect(isNotFound(thrown)).toBe(true);
    expect((thrown as GithubApiError).message).toContain('(input: {"number":7})');
  });

  it("rawFetch 第二次仍是 401 时抛 GithubApiError（不无限重试）", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ message: "Bad credentials" }, 401),
    ) as unknown as typeof fetch;
    const api = createGithubApi({ fetch: fetchImpl, token: async () => "expired" });

    const thrown: unknown = await api
      .rawFetch("https://api.github.com/repos/o/r/zipball/v1")
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GithubApiError);
    expect((thrown as GithubApiError).status).toBe(401);
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(2);
  });
});
