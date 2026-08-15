import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bwrap/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bwrap/core.js")>();
  return {
    ...actual,
    findBwrap: () => {
      throw new Error("bwrap (bubblewrap) not found in PATH");
    },
  };
});

import { type BwrapRuntime, createBwrapRuntime } from "../src/bwrap/runtime.js";

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

function startSession(runtime: BwrapRuntime, pi: { on: ReturnType<typeof vi.fn> }) {
  const call = pi.on.mock.calls.find((c) => c[0] === "session_start");
  const handler = call?.[1] as (
    event: unknown,
    ctx: { cwd: string; hasUI: boolean; ui: unknown },
  ) => void;
  const ui = { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } };
  handler({}, { cwd: process.cwd(), hasUI: true, ui });
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

  describe("bwrap binary unavailable", () => {
    it("refuses all commands instead of degrading to allow-all", async () => {
      const { runtime, pi } = setupRuntime();
      startSession(runtime, pi);
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "echo should-not-run",
          ctx: { cwd: process.cwd(), hasUI: true } as never,
        }),
      ).rejects.toThrow(/refusing to execute commands without sandboxing/);
    });

    it("still runs commands after the user explicitly switches to allow-all", async () => {
      const { runtime, pi } = setupRuntime();
      startSession(runtime, pi);
      runtime.setMode(process.cwd(), "allow-all");
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf runtime",
        ctx: { cwd: process.cwd(), hasUI: true } as never,
      });
      expect(result.content[0]).toMatchObject({ type: "text", text: "runtime" });
    });
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
      const select = vi
        .fn()
        .mockResolvedValueOnce("Block")
        .mockResolvedValueOnce("Block with reason");
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

    it("denies without feedback when the reason input is cancelled", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi
        .fn()
        .mockResolvedValueOnce("Block")
        .mockResolvedValueOnce("Block with reason");
      const input = vi.fn().mockResolvedValue(undefined);
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf should-not-run",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input }),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution\.$/);
      // 无循环：单选 1 + 单选 2 各一次，input 取消后直接拒绝
      expect(select).toHaveBeenCalledTimes(2);
      expect(input).toHaveBeenCalledTimes(1);
    });

    it("denies without reason text when the reason input is blank", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi
        .fn()
        .mockResolvedValueOnce("Block")
        .mockResolvedValueOnce("Block with reason");
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

    it("denies without feedback when the second selection is dismissed", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn().mockResolvedValueOnce("Block").mockResolvedValueOnce(undefined);
      const abort = vi.fn();
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf should-not-run",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input: vi.fn() }, abort),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution\.$/);
      expect(abort).not.toHaveBeenCalled();
    });
  });
});
