/**
 * Tests for the gh-readonly extension's startup check: when the `gh` CLI is
 * missing, the extension must register no tools (fail fast) and report the
 * problem at session start, instead of registering tools that fail on every
 * call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { existsMock } = vi.hoisted(() => ({ existsMock: vi.fn() }));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsMock(...args),
}));

import registerTools from "../src/gh-readonly.js";

function createPi() {
  const tools: unknown[] = [];
  const handlers: [string, unknown][] = [];
  const pi = {
    registerTool: (tool: unknown) => {
      tools.push(tool);
    },
    on: (event: string, handler: unknown) => {
      handlers.push([event, handler]);
    },
  };
  return { pi, tools, handlers };
}

describe("gh-readonly setup", () => {
  afterEach(() => {
    existsMock.mockReset();
  });

  it("registers no tools and reports an error at session start when gh is missing", async () => {
    existsMock.mockReturnValue(false);
    const { pi, tools, handlers } = createPi();
    registerTools(pi as never);

    expect(tools).toHaveLength(0);

    const sessionStart = handlers.find(([event]) => event === "session_start");
    expect(sessionStart).toBeDefined();
    const notify = vi.fn();
    (sessionStart?.[1] as (event: unknown, ctx: { ui: { notify: typeof notify } }) => void)(
      {},
      { ui: { notify } },
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("gh CLI not found"), "error");
  });

  it("registers the full toolset when gh is available", () => {
    existsMock.mockReturnValue(true);
    const { pi, tools } = createPi();
    registerTools(pi as never);

    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => (t as { name: string }).name)).toEqual(
      expect.arrayContaining(["read-github-issue", "read-github-pr", "watch-github-run"]),
    );
  });
});
