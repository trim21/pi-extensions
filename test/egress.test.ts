/**
 * Tests for the shared egress entry point (`src/lib/egress.ts`):
 * - the proxy adapter's `settings` / `env` / `fetch` are handed through as-is
 * - a broken proxy config makes `createEgress()` throw instead of silently
 *   falling back to a direct connection
 *
 * The adapter is mocked so the assertions do not depend on the developer's
 * ~/.pi/agent/proxy.json.
 */
import { describe, expect, it, vi } from "vitest";

const { createHttpProxyMock, proxyAdapter } = vi.hoisted(() => {
  const adapter = {
    settings: { proxy: "http://config:7890", noProxy: "localhost" },
    env: { HTTPS_PROXY: "http://config:7890" },
    fetch: vi.fn(),
  };
  return { createHttpProxyMock: vi.fn(() => adapter), proxyAdapter: adapter };
});

vi.mock("../src/lib/proxy.js", () => ({
  createHttpProxy: createHttpProxyMock,
}));

import { createEgress, egress } from "../src/lib/egress.js";

describe("createEgress", () => {
  it("exposes the proxy adapter's settings, env and fetch untouched", () => {
    const instance = createEgress();

    expect(instance.settings).toBe(proxyAdapter.settings);
    expect(instance.env).toBe(proxyAdapter.env);
    expect(instance.fetch).toBe(proxyAdapter.fetch);
  });

  it("builds the shared instance from the proxy adapter too", () => {
    expect(egress.settings).toBe(proxyAdapter.settings);
    expect(egress.env).toBe(proxyAdapter.env);
    expect(egress.fetch).toBe(proxyAdapter.fetch);
  });

  it("propagates a proxy config error instead of connecting directly", () => {
    createHttpProxyMock.mockImplementationOnce(() => {
      throw new Error("proxy.json: invalid proxy URL");
    });

    expect(() => createEgress()).toThrow("proxy.json: invalid proxy URL");
  });
});
