import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bwrap/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bwrap/core.js")>();
  return {
    ...actual,
    findBwrap: () => {
      throw new Error("bwrap (bubblewrap) not found in PATH");
    },
  };
});

const { dcgSuggestionMock } = vi.hoisted(() => ({ dcgSuggestionMock: vi.fn() }));

vi.mock("../src/bwrap/dcg-scan.js", () => ({
  dcgSuggestion: (...args: unknown[]) => dcgSuggestionMock(...args),
}));

import {
  ALLOW_FOREVER,
  ALLOW_ONCE,
  type BwrapRuntime,
  createBwrapRuntime,
  DENY,
  DENY_WITH_REASON,
} from "../src/bwrap/runtime.js";

beforeAll(() => {
  // Bash 输出运行时落盘到 agent-dir/tmp：测试环境指向可写的临时目录
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cc-bwrap-agent-dir-"));
});

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

function fullAccessContext(ui: unknown, abort: () => void = vi.fn(), cwd = process.cwd()) {
  return { cwd, hasUI: true, signal: undefined, abort, ui } as never;
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
    dcgSuggestionMock.mockReset();
    // 默认视为 dcg 未安装：静默跳过，不影响任何审批断言
    dcgSuggestionMock.mockResolvedValue({ kind: "not-installed" });
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
      expect(result).toMatchObject({ exitCode: 0, output: "runtime" });
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
    expect(result).toMatchObject({ exitCode: 0, output: "runtime" });
  });

  it("returns the full result for non-zero exit codes instead of throwing", async () => {
    const { runtime } = setupRuntime();
    runtime.setMode(process.cwd(), "allow-all");
    const result = await runtime.execute({
      toolCallId: "test",
      command: "sh -c 'printf oops; exit 3'",
      ctx: { cwd: process.cwd(), hasUI: true } as never,
    });
    expect(result).toMatchObject({ exitCode: 3, output: "oops" });
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

  describe("approval rules", () => {
    beforeEach(() => {
      // 在测试 agent 目录写入带 approvalRules 的全局配置
      writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"),
        JSON.stringify({
          approvalRules: [
            { action: "allow", pattern: "git status *" },
            { action: "deny", pattern: "git push *" },
          ],
        }),
      );
    });

    it("auto-allows commands matching an allow rule without a dialog", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      // workspace-write + approvalRules.allow(git status *) → 直接放行，不弹框
      const select = vi.fn();
      const result = await runtime.execute({
        toolCallId: "test",
        command: "git status",
        requestFullAccess: true,
        requestFullAccessReason: "test",
        ctx: fullAccessContext({ select, input: vi.fn() }),
      });
      expect(result).toMatchObject({ exitCode: 0 });
      expect(select).not.toHaveBeenCalled();
    });

    it("auto-denies commands matching a deny rule without a dialog", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn();
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "git push origin main",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input: vi.fn() }),
        }),
      ).rejects.toThrow(/Command denied by bwrap approval rule/);
      expect(select).not.toHaveBeenCalled();
    });

    it("falls back to the dialog when no rule matches", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => "Approve once");
      const result = await runtime.execute({
        toolCallId: "test",
        command: "git rev-parse --abbrev-ref HEAD",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }),
      });
      expect(select).toHaveBeenCalled();
      expect(result).toMatchObject({ exitCode: 0 });
    });
  });

  describe("full-access approval dialog", () => {
    it("runs the command when the user approves once", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => ALLOW_ONCE);
      const abort = vi.fn();
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf approved",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }, abort),
      });
      expect(result).toMatchObject({ exitCode: 0, output: "approved" });
      expect(abort).not.toHaveBeenCalled();
    });

    it("shows the dcg suggestion inside the approval dialog when available", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      dcgSuggestionMock.mockResolvedValue({
        kind: "suggestion",
        suggestion: { kind: "danger", text: "dcg 建议拦截: test" },
      });
      const select = vi.fn(async () => ALLOW_ONCE);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "rm -rf /tmp/x",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }),
      });
      expect(select).toHaveBeenCalledWith(
        expect.stringContaining("dcg 建议拦截: test"),
        expect.anything(),
        expect.anything(),
      );
      expect(result).toMatchObject({ exitCode: 0 });
    });

    it("renders the dialog without a dcg block when dcg is not installed", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      // 默认 not-installed：不显示建议块，也不 notify
      const notify = vi.fn();
      const select = vi.fn(async () => ALLOW_ONCE);
      await runtime.execute({
        toolCallId: "test",
        command: "printf ok",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn(), notify }),
      });
      expect(select).toHaveBeenCalledWith(
        expect.not.stringContaining("dcg"),
        expect.anything(),
        expect.anything(),
      );
      expect(notify).not.toHaveBeenCalled();
    });

    it("notifies a warning when the dcg scan fails", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      dcgSuggestionMock.mockResolvedValue({ kind: "failed", detail: "dcg scan timed out" });
      const notify = vi.fn();
      const select = vi.fn(async () => ALLOW_ONCE);
      await runtime.execute({
        toolCallId: "test",
        command: "printf ok",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn(), notify }),
      });
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("dcg 扫描失败"), "warning");
      // 失败时弹窗照常出现，只是没有建议块
      expect(select).toHaveBeenCalledWith(
        expect.not.stringContaining("dcg"),
        expect.anything(),
        expect.anything(),
      );
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

    it("denies without feedback when the user denies", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => DENY);
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

    it("includes the typed reason when the user denies with reason", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => DENY_WITH_REASON);
      const input = vi.fn(async () => "too risky");
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf should-not-run",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input }),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution: too risky/);
      expect(select).toHaveBeenCalledTimes(1);
      expect(input).toHaveBeenCalledTimes(1);
    });

    it("denies without feedback when the reason input is cancelled", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => DENY_WITH_REASON);
      const input = vi.fn().mockResolvedValue(undefined);
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf should-not-run",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input }),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution\.$/);
      // 无循环：单选 1 次，input 取消后直接拒绝
      expect(select).toHaveBeenCalledTimes(1);
      expect(input).toHaveBeenCalledTimes(1);
    });

    it("denies without reason text when the reason input is blank", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => DENY_WITH_REASON);
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

    it("allow forever persists an allow rule and auto-approves next time", async () => {
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-forever-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf forever",
        requestFullAccess: true,
        ctx: fullAccessContext(
          { select: vi.fn(async () => ALLOW_FOREVER), input: vi.fn() },
          undefined,
          directory,
        ),
      });
      expect(result).toMatchObject({ exitCode: 0, output: "forever" });
      // 项目配置写入 allow 规则
      const config = JSON.parse(readFileSync(join(directory, ".pi", "bwrap.json"), "utf8")) as {
        approvalRules: { action: string; pattern: string }[];
      };
      expect(config.approvalRules).toEqual([{ action: "allow", pattern: "printf *" }]);
      // 同命令再次执行：命中规则，不再弹框
      const select2 = vi.fn();
      const result2 = await runtime.execute({
        toolCallId: "test2",
        command: "printf forever",
        requestFullAccess: true,
        ctx: fullAccessContext({ select: select2, input: vi.fn() }, undefined, directory),
      });
      expect(result2).toMatchObject({ exitCode: 0, output: "forever" });
      expect(select2).not.toHaveBeenCalled();
    });
  });
});
