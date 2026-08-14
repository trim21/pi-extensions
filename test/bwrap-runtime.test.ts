import { afterEach, describe, expect, it, vi } from "vitest";

import { createBwrapRuntime } from "../src/bwrap/runtime.js";

function setupRuntime() {
  const runtime = createBwrapRuntime();
  const pi = {
    getFlag: vi.fn(() => false),
    registerFlag: vi.fn(),
    on: vi.fn(),
    registerCommand: vi.fn(),
  };
  runtime.setup(pi as never);
  return { runtime, pi };
}

describe("BwrapRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers flags, lifecycle handlers, and bwrap commands in setup", () => {
    const { pi } = setupRuntime();
    expect(pi.registerFlag).toHaveBeenCalledWith("no-bwrap", expect.any(Object));
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(pi.registerCommand).toHaveBeenCalledWith("bwrap-readonly", expect.any(Object));
  });

  it("executes through its selected allow-all policy", async () => {
    const { runtime } = setupRuntime();
    runtime.setMode(process.cwd(), "allow-all");
    const result = await runtime.execute({
      toolCallId: "test",
      command: "printf runtime",
      ctx: { cwd: process.cwd(), hasUI: true } as never,
    });
    expect(result.content[0]).toMatchObject({ type: "text", text: "runtime" });
  });

  it("rejects full-access requests before execution without a UI", async () => {
    const { runtime } = setupRuntime();
    await expect(
      runtime.execute({
        toolCallId: "test",
        command: "printf should-not-run",
        requestFullAccess: true,
        ctx: { cwd: process.cwd(), hasUI: false } as never,
      }),
    ).rejects.toThrow(/no UI is available/);
  });
});
