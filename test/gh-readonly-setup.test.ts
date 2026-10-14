/**
 * Tests for the gh-readonly extension's startup check: when the `gh` CLI is
 * missing, the extension must register no tools (fail fast) and report the
 * problem at session start, instead of registering tools that fail on every
 * call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { existsMock } = vi.hoisted(() => ({ existsMock: vi.fn() }));

// Partial mock: only the gh-detection probe is stubbed, the rest of node:fs
// (e.g. the proxy config read at extension load) stays real.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: (...args: unknown[]) => existsMock(...args),
}));

import registerTools, { createGithubTools } from "../src/gh/index.js";
import { createToolBus } from "../src/lib/tool-bus.js";

function createPi() {
  const tools: unknown[] = [];
  const handlers: [string, unknown][] = [];
  const pi = {
    registerTool: (tool: unknown) => {
      tools.push(tool);
    },
    on: (event: string, handler: unknown) => {
      handlers.push([event, handler]);
      // 注册即触发：等价于 session_start 事件按注册顺序派发（工具在
      // session_start 里按本会话模型注册）
      if (event === "session_start") {
        void (handler as (event: unknown, ctx: unknown) => unknown)(
          { type: "session_start", reason: "startup" },
          { model: undefined, cwd: process.cwd(), ui: { notify: vi.fn() } },
        );
      }
    },
  };
  return { pi, tools, handlers };
}

describe.skipIf(process.platform === "win32")("gh-readonly setup", () => {
  // Windows 上扩展整体禁用（见下方 "Windows: gh-readonly disabled"），
  // 这两个 gh 可用性检测用例只属于非 Windows 平台语义。
  afterEach(() => {
    existsMock.mockReset();
  });

  it("registers no tools and warns at session start when gh is missing", async () => {
    existsMock.mockReturnValue(false);
    const { pi, tools, handlers } = createPi();
    registerTools(pi as never);

    expect(tools).toHaveLength(0);

    // createToolRegistration 先挂一个「记录本会话模型」的 handler，注册（与提示）
    // 发生在它之后那一个。
    const sessionStart = handlers.findLast(([event]) => event === "session_start");
    expect(sessionStart).toBeDefined();
    const notify = vi.fn();
    (sessionStart?.[1] as (event: unknown, ctx: { ui: { notify: typeof notify } }) => void)(
      {},
      { ui: { notify } },
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("gh CLI not found"), "warning");
  });

  it("hands no gh tool to pi, but registers them as codemode-only on the bus", () => {
    existsMock.mockReturnValue(true);
    const { pi, tools } = createPi();
    registerTools(pi as never);

    // gh 工具只经 codemode 曝光：pi 一个都拿不到
    expect(tools).toHaveLength(0);

    const bus = createToolBus({ registerTool: () => {} } as never);
    createGithubTools().register(bus, { model: undefined, ui: { notify: vi.fn() } } as never);
    const registered = bus.list();
    expect(registered).toHaveLength(18);
    expect(registered.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read-github-issue", "read-github-pr", "watch-github-run"]),
    );
    expect(registered.every((tool) => tool.codemodeOnly === true)).toBe(true);
  });
});

describe("Windows: gh-readonly disabled", () => {
  // 无论测试跑在哪个平台都模拟 win32：Windows 上扩展整体禁用，不注册任何
  // 工具，session 启动时提示禁用原因。
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  it("registers no tools even when gh is available", () => {
    existsMock.mockReturnValue(true);
    const { pi, tools } = createPi();
    registerTools(pi as never);
    expect(tools).toHaveLength(0);
  });

  it("notifies the disable reason at session start", () => {
    const { pi, handlers } = createPi();
    registerTools(pi as never);
    // createToolRegistration 先挂一个「记录本会话模型」的 handler，注册（与提示）
    // 发生在它之后那一个。
    const sessionStart = handlers.findLast(([event]) => event === "session_start");
    expect(sessionStart).toBeDefined();
    const notify = vi.fn();
    (sessionStart?.[1] as (event: unknown, ctx: { ui: { notify: typeof notify } }) => void)(
      {},
      { ui: { notify } },
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("disabled on Windows"), "warning");
  });
});
