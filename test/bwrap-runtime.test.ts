import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { dcgSuggestionMock, localCreateMock } = vi.hoisted(() => ({
  dcgSuggestionMock: vi.fn(),
  localCreateMock: vi.fn(),
}));

vi.mock("../src/bwrap/dcg-scan.js", () => ({
  dcgSuggestion: (...args: unknown[]) => dcgSuggestionMock(...args),
}));

// createLocalBashOperations 默认走真实实现（Linux 上的 bash 测试），
// Windows 语义测试通过 localCreateMock 覆盖为记录式 fake：mock win32 时
// pi 的本地 shell 层会去找 Git Bash（Linux 上没有），审批通过后的"执行"
// 只需验证走了本地执行路径，不需要真实 shell。
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createLocalBashOperations: (...args: unknown[]) => {
      const overridden = localCreateMock(...args);
      return (
        overridden ??
        actual.createLocalBashOperations(
          ...(args as Parameters<typeof actual.createLocalBashOperations>),
        )
      );
    },
  };
});

import {
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
  return {
    cwd,
    hasUI: true,
    sessionManager: { getSessionId: () => "test-session" },
    signal: undefined,
    abort,
    ui,
  } as never;
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
    localCreateMock.mockReset();
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
    // Linux/macOS 语义：bwrap 缺失时 fail closed，普通命令一律拒绝。
    // Windows 上 bwrap 缺失是预期状态，走"每条命令人工审核"分支（见下方
    // "Windows" describe），此测试在 Windows CI 上跳过。
    it.skipIf(process.platform === "win32")(
      "refuses all commands instead of degrading to allow-all",
      async () => {
        const { runtime, pi } = setupRuntime();
        startSession(runtime, pi);
        await expect(
          runtime.execute({
            toolCallId: "test",
            command: "echo should-not-run",
            ctx: {
              cwd: process.cwd(),
              hasUI: true,
              sessionManager: { getSessionId: () => "test-session" },
            } as never,
          }),
        ).rejects.toThrow(/refusing to execute commands without sandboxing/);
      },
    );

    it("still runs commands after the user explicitly switches to allow-all", async () => {
      const { runtime, pi } = setupRuntime();
      startSession(runtime, pi);
      runtime.setMode(process.cwd(), "allow-all");
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf runtime",
        ctx: {
          cwd: process.cwd(),
          hasUI: true,
          sessionManager: { getSessionId: () => "test-session" },
        } as never,
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
      ctx: {
        cwd: process.cwd(),
        hasUI: true,
        sessionManager: { getSessionId: () => "test-session" },
      } as never,
    });
    expect(result).toMatchObject({ exitCode: 0, output: "runtime" });
  });

  it("returns the full result for non-zero exit codes instead of throwing", async () => {
    const { runtime } = setupRuntime();
    runtime.setMode(process.cwd(), "allow-all");
    const result = await runtime.execute({
      toolCallId: "test",
      command: "sh -c 'printf oops; exit 3'",
      ctx: {
        cwd: process.cwd(),
        hasUI: true,
        sessionManager: { getSessionId: () => "test-session" },
      } as never,
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
        description: "test",
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
      const select = vi.fn(async () => ALLOW_ONCE);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "git rev-parse --abbrev-ref HEAD",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }),
      });
      expect(select).toHaveBeenCalled();
      expect(result).toMatchObject({ exitCode: 0 });
    });

    it("does not auto-allow a file redirect under an echo * rule", async () => {
      writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"),
        JSON.stringify({
          approvalRules: [{ action: "allow", pattern: "echo *" }],
        }),
      );
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => DENY);
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "echo '' > file",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input: vi.fn() }),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution/);
      expect(select).toHaveBeenCalled();
      rmSync(join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"), { force: true });
    });

    it("shows only unallowed patterns as checkboxes when part of a chain is pre-approved", async () => {
      // 覆盖全局规则：`echo *` 已 allow，`head *` 未允许
      writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"),
        JSON.stringify({
          approvalRules: [{ action: "allow", pattern: "echo *" }],
        }),
      );
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-partial-allow-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      const select = vi
        .fn()
        .mockImplementationOnce(async (_title: string, options: string[]) => {
          // checkbox 只列出未允许的 `head *`，不含已允许的 `echo *`
          expect(options).toEqual([ALLOW_ONCE, DENY, DENY_WITH_REASON, "☐ head *"]);
          return "☐ head *";
        })
        .mockResolvedValueOnce(ALLOW_ONCE);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "echo hi && head -n 1 /dev/null",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }, undefined, directory),
      });
      expect(result).toMatchObject({ exitCode: 0 });
      // 勾选持久化只写入未允许的 pattern，已 allow 的不重复写入
      const config = JSON.parse(readFileSync(join(directory, ".pi", "bwrap.json"), "utf8")) as {
        approvalRules: { action: string; pattern: string }[];
      };
      expect(config.approvalRules).toEqual([{ action: "allow", pattern: "head *" }]);
      // 重置全局规则，避免残留影响后续 describe 的审批断言
      rmSync(join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"), { force: true });
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

    it("shows the resolved exec cwd inside the approval dialog when workdir is provided", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => ALLOW_ONCE);
      // workdir 传相对路径（原始参数值），cwd 是 bash 工具解析后的实际执行目录
      const execCwd = mkdtempSync(join(tmpdir(), "cc-bwrap-workdir-"));
      await runtime.execute({
        toolCallId: "test",
        command: "printf wd",
        requestFullAccess: true,
        cwd: execCwd,
        ctx: fullAccessContext({ select, input: vi.fn() }),
      });
      expect(select).toHaveBeenCalledWith(
        expect.stringContaining(`Workdir: ${execCwd}`),
        expect.anything(),
        expect.anything(),
      );
    });

    it("omits the workdir line when the workdir argument is absent", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => ALLOW_ONCE);
      await runtime.execute({
        toolCallId: "test",
        command: "printf ok",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }),
      });
      expect(select).toHaveBeenCalledWith(
        expect.not.stringContaining("Workdir"),
        expect.anything(),
        expect.anything(),
      );
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
      ).rejects.toThrow(/User denied command execution with reason: too risky/);
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
      ).rejects.toThrow(/User denied command execution\.$/);
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
      ).rejects.toThrow(/User denied command execution\.$/);
    });

    it("allow forever persists only the checked rules and auto-approves next time", async () => {
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-forever-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      // 勾选 `printf *`（checkbox 首轮为 ☐ 前缀），然后选 Allow once 放行本次
      const select = vi.fn().mockResolvedValueOnce("☐ printf *").mockResolvedValueOnce(ALLOW_ONCE);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf forever",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }, undefined, directory),
      });
      expect(result).toMatchObject({ exitCode: 0, output: "forever" });
      // 项目配置只写入勾选的规则
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

    it("persists only the checked patterns of a pipeline command", async () => {
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-partial-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      // `echo 1 | head` 识别出 `echo *` 与 `head *` 两个 pattern：
      // 只勾选 `echo *`，`head *` 不持久化
      const select = vi
        .fn()
        .mockImplementationOnce(async (_title: string, options: string[]) => {
          // 操作在前，checkbox 规则在后
          expect(options).toEqual([ALLOW_ONCE, DENY, DENY_WITH_REASON, "☐ echo *", "☐ head *"]);
          return "☐ echo *";
        })
        .mockResolvedValueOnce(ALLOW_ONCE);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "echo 1 | head",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }, undefined, directory),
      });
      expect(result).toMatchObject({ exitCode: 0, output: "1\n" });
      const config = JSON.parse(readFileSync(join(directory, ".pi", "bwrap.json"), "utf8")) as {
        approvalRules: { action: string; pattern: string }[];
      };
      expect(config.approvalRules).toEqual([{ action: "allow", pattern: "echo *" }]);
      // 纯 head 命令仍未命中规则：需要重新审批
      const select2 = vi.fn(async () => ALLOW_ONCE);
      await runtime.execute({
        toolCallId: "test2",
        command: "head -n 1 file.txt",
        requestFullAccess: true,
        ctx: fullAccessContext({ select: select2, input: vi.fn() }, undefined, directory),
      });
      expect(select2).toHaveBeenCalled();
    });

    it("allow once without checking any rule runs without persisting", async () => {
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-once-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      const select = vi.fn(async () => ALLOW_ONCE);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf once",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }, undefined, directory),
      });
      expect(result).toMatchObject({ exitCode: 0, output: "once" });
      // 未勾选任何规则：不写入 bwrap.json
      expect(existsSync(join(directory, ".pi", "bwrap.json"))).toBe(false);
      // 同命令再次执行：无规则命中，仍需审批
      const select2 = vi.fn(async () => ALLOW_ONCE);
      await runtime.execute({
        toolCallId: "test2",
        command: "printf once",
        requestFullAccess: true,
        ctx: fullAccessContext({ select: select2, input: vi.fn() }, undefined, directory),
      });
      expect(select2).toHaveBeenCalled();
    });

    it("checked rules persist as allow even when the user denies", async () => {
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-deny-allow-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      // 勾选 `printf *` 后点 Deny：本次拒绝，但规则持久化为 allow
      const select = vi.fn().mockResolvedValueOnce("☐ printf *").mockResolvedValueOnce(DENY);
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf no",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input: vi.fn() }, undefined, directory),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution/);
      const config = JSON.parse(readFileSync(join(directory, ".pi", "bwrap.json"), "utf8")) as {
        approvalRules: { action: string; pattern: string }[];
      };
      expect(config.approvalRules).toEqual([{ action: "allow", pattern: "printf *" }]);
      // 同 pattern 命令后续自动放行，不再弹框
      const select2 = vi.fn();
      const result2 = await runtime.execute({
        toolCallId: "test2",
        command: "printf yes",
        requestFullAccess: true,
        ctx: fullAccessContext({ select: select2, input: vi.fn() }, undefined, directory),
      });
      expect(result2).toMatchObject({ exitCode: 0, output: "yes" });
      expect(select2).not.toHaveBeenCalled();
    });

    it("checked rules persist as allow even when the user denies with reason", async () => {
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-deny-reason-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      const select = vi
        .fn()
        .mockResolvedValueOnce("☐ printf *")
        .mockResolvedValueOnce(DENY_WITH_REASON);
      const input = vi.fn(async () => "risky args");
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf no",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input }, undefined, directory),
        }),
      ).rejects.toThrow(/User denied command execution with reason: risky args/);
      const config = JSON.parse(readFileSync(join(directory, ".pi", "bwrap.json"), "utf8")) as {
        approvalRules: { action: string; pattern: string }[];
      };
      expect(config.approvalRules).toEqual([{ action: "allow", pattern: "printf *" }]);
    });
  });
});

describe("Windows (no bwrap): every command requires approval", () => {
  // Windows 没有 bubblewrap：bwrap 缺失是预期状态，降级为每条命令人工审核。
  // 无论测试跑在哪个平台都模拟 win32，保证两个 CI 上验证同一套行为。
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    // 重置全局 approvalRules，避免前序测试的规则残留影响审批判定
    rmSync(join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"), { force: true });
    // 审批通过后走本地执行路径：mock 掉 createLocalBashOperations，避免 mock
    // win32 下 pi 去找 Git Bash；fake exec 把命令文本回显为输出，便于断言。
    localCreateMock.mockReturnValue({
      exec: async (
        command: string,
        _cwd: string,
        { onData }: { onData: (data: Buffer) => void },
      ) => {
        onData(Buffer.from(`${command}\n`));
        return { exitCode: 0 };
      },
    });
  });

  it("skips bwrap checks at session start and announces per-command approval", () => {
    const { pi } = setupRuntime();
    const call = pi.on.mock.calls.find((c) => c[0] === "session_start");
    const handler = call?.[1] as (
      event: unknown,
      ctx: { cwd: string; hasUI: boolean; ui: unknown },
    ) => void;
    const ui = { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } };
    handler({}, { cwd: process.cwd(), hasUI: true, ui });
    expect(ui.notify).toHaveBeenCalledWith(
      "Every bash command requires user approval before it runs.",
      "info",
    );
    // Windows 上没有 bwrap 状态可言：不设置 bwrap status
    expect(ui.setStatus).not.toHaveBeenCalled();
  });

  it("does not mention bwrap in the injected system prompt", () => {
    const { pi } = setupRuntime();
    const call = pi.on.mock.calls.find((c) => c[0] === "before_agent_start");
    const handler = call?.[1] as (
      event: { systemPrompt: string },
      ctx: { cwd: string; hasUI: boolean },
    ) => { systemPrompt: string } | undefined;
    const result = handler?.({ systemPrompt: "base" }, { cwd: process.cwd(), hasUI: true });
    expect(result?.systemPrompt).toContain("Every bash command requires user approval");
    expect(result?.systemPrompt).not.toContain("bwrap");
  });

  it("gates a plain command behind the approval dialog and runs after approve", async () => {
    const { runtime, pi } = setupRuntime();
    startSession(runtime, pi);
    const select = vi.fn(async () => ALLOW_ONCE);
    const result = await runtime.execute({
      toolCallId: "test",
      command: "printf windows",
      ctx: fullAccessContext({ select, input: vi.fn() }),
    });
    expect(select).toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("printf windows");
  });

  it("auto-denies commands matching a deny rule without a dialog", async () => {
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"),
      JSON.stringify({ approvalRules: [{ action: "deny", pattern: "printf *" }] }),
    );
    const { runtime } = setupRuntime();
    const select = vi.fn();
    await expect(
      runtime.execute({
        toolCallId: "test",
        command: "printf windows",
        ctx: fullAccessContext({ select, input: vi.fn() }),
      }),
    ).rejects.toThrow(/Command denied by bwrap approval rule/);
    expect(select).not.toHaveBeenCalled();
  });

  it("auto-allows commands matching an allow rule without a dialog", async () => {
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"),
      JSON.stringify({ approvalRules: [{ action: "allow", pattern: "printf *" }] }),
    );
    const { runtime } = setupRuntime();
    const select = vi.fn();
    const result = await runtime.execute({
      toolCallId: "test",
      command: "printf windows",
      ctx: fullAccessContext({ select, input: vi.fn() }),
    });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("printf windows");
    expect(select).not.toHaveBeenCalled();
  });

  it("allow-all mode skips approval (explicit opt-out)", async () => {
    const { runtime, pi } = setupRuntime();
    startSession(runtime, pi);
    runtime.setMode(process.cwd(), "allow-all");
    const select = vi.fn();
    const result = await runtime.execute({
      toolCallId: "test",
      command: "printf windows",
      ctx: fullAccessContext({ select, input: vi.fn() }),
    });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("printf windows");
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects commands without a UI (no approval possible)", async () => {
    const { runtime } = setupRuntime();
    await expect(
      runtime.execute({
        toolCallId: "test",
        command: "printf should-not-run",
        ctx: { cwd: process.cwd(), hasUI: false } as never,
      }),
    ).rejects.toThrow(/no UI is available/);
  });
});
