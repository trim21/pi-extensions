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

function fullAccessContext(ui: unknown, abort: () => void = vi.fn()) {
  return { cwd: process.cwd(), hasUI: true, signal: undefined, abort, ui } as never;
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

  describe("full-access approval dialog", () => {
    it("runs the command when the user approves once", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => "Approve once");
      const abort = vi.fn();
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf approved",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }, abort),
      });
      expect(result.content[0]).toMatchObject({ type: "text", text: "approved" });
      expect(abort).not.toHaveBeenCalled();
    });

    it("aborts and denies when the selection is dismissed", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn().mockResolvedValue(undefined);
      const abort = vi.fn();
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf should-not-run",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input: vi.fn() }, abort),
        }),
      ).rejects.toThrow(/User denied the command execution/);
      expect(abort).toHaveBeenCalled();
    });

    it("denies without feedback when the user blocks", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => "Block");
      const abort = vi.fn();
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf should-not-run",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input: vi.fn() }, abort),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution/);
      expect(abort).not.toHaveBeenCalled();
    });

    it("includes the typed reason when the user blocks with reason", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => "Block with reason");
      const input = vi.fn(async () => "too risky");
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf should-not-run",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input }),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution: too risky/);
    });

    it("re-asks when the reason input is cancelled", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi
        .fn()
        .mockResolvedValueOnce("Block with reason")
        .mockResolvedValueOnce("Approve once");
      const input = vi.fn().mockResolvedValue(undefined);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf approved",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input }),
      });
      expect(select).toHaveBeenCalledTimes(2);
      expect(result.content[0]).toMatchObject({ type: "text", text: "approved" });
    });

    it("denies without reason text when the reason input is blank", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => "Block with reason");
      const input = vi.fn(async () => " ".repeat(3));
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf should-not-run",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input }),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution\.$/);
    });
  });
});
