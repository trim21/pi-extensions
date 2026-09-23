import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bwrap/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bwrap/core.js")>();
  return {
    ...actual,
    findBwrap: () => {
      throw new Error("bwrap (bubblewrap) not found in PATH");
    },
    // 本文件只验证审批流与结果拼装：沙箱执行路径降级为本地执行（真实 bwrap 行为由
    // bwrap-sandbox.test.ts 覆盖），bwrapOpsCreateMock 记录调用供「走了沙箱路径」断言
    createBwrapBashOperations: (...args: unknown[]) => {
      bwrapOpsCreateMock(...args);
      return createLocalBashOperations();
    },
  };
});

const { dcgSuggestionMock, localCreateMock, bwrapOpsCreateMock } = vi.hoisted(() => ({
  dcgSuggestionMock: vi.fn(),
  localCreateMock: vi.fn(),
  bwrapOpsCreateMock: vi.fn(),
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

import { type BwrapConfig, resolveBwrap } from "../src/bwrap/core.js";
import {
  ALLOW_ONCE,
  BACK,
  BashInterruptedError,
  type BwrapRuntime,
  createBwrapRuntime,
  DENY,
  DENY_WITH_REASON,
  describeSandbox,
  EDIT_RULES,
  RUN_IN_SANDBOX,
} from "../src/bwrap/runtime.js";
import { createRequestPolicy, type RequestPolicy } from "../src/lib/request-policy.js";

beforeAll(() => {
  // Bash 输出运行时落盘到 agent-dir/tmp：测试环境指向可写的临时目录
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cc-bwrap-agent-dir-"));
});

function setupRuntime(policy: RequestPolicy = createRequestPolicy(), config?: BwrapConfig) {
  const runtime = createBwrapRuntime(policy, config);
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

/** 调用已注册的 /bwrap-* 命令处理器（runCommand → handler(args, ctx)）。 */
async function runBwrapCommand(
  pi: { registerCommand: ReturnType<typeof vi.fn> },
  name: string,
  ctx: unknown,
): Promise<void> {
  const call = pi.registerCommand.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`command not registered: ${name}`);
  const { handler } = call[1] as { handler: (args: string, ctx: unknown) => Promise<void> };
  await handler("", ctx);
}

/** 命令 handler 的 ctx：只用到 cwd / hasUI / ui（notify + setStatus + theme）。 */
function commandContext(cwd = process.cwd()) {
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    theme: { fg: (_color: string, text: string) => text },
  };
  return { ctx: { cwd, hasUI: true, ui } as never, ui };
}

/** 调用 before_agent_start 处理器并返回注入后的 system prompt。 */
function beforeAgentStart(pi: { on: ReturnType<typeof vi.fn> }, cwd = process.cwd()): string {
  const call = pi.on.mock.calls.find((c) => c[0] === "before_agent_start");
  const handler = call?.[1] as (
    event: { systemPrompt: string },
    ctx: { cwd: string; hasUI: boolean },
  ) => { systemPrompt: string } | undefined;
  return handler({ systemPrompt: "base" }, { cwd, hasUI: true })?.systemPrompt ?? "";
}

describe("BwrapRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localCreateMock.mockReset();
    bwrapOpsCreateMock.mockReset();
    dcgSuggestionMock.mockReset();
    // 默认视为 dcg 未安装：静默跳过，不影响任何审批断言
    dcgSuggestionMock.mockResolvedValue({ kind: "not-installed" });
  });

  it("registers lifecycle handlers and bwrap commands in setup", () => {
    const { pi } = setupRuntime();
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(pi.registerCommand).toHaveBeenCalledWith("bwrap-readonly", expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith("bwrap-deny-request", expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith("bwrap-allow-request", expect.any(Object));
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

  it("attaches partial output to timeout errors", async () => {
    const { runtime } = setupRuntime();
    runtime.setMode(process.cwd(), "allow-all");
    await expect(
      runtime.execute({
        toolCallId: "test",
        command: "printf partial; sleep 1",
        timeout: 0.02,
        ctx: {
          cwd: process.cwd(),
          hasUI: true,
          sessionManager: { getSessionId: () => "test-session" },
        } as never,
      }),
    ).rejects.toMatchObject({
      kind: "timeout",
      name: "TimeoutError",
      message: "Command timed out after 0.02 seconds",
      partial: { output: "partial" },
    });
  });

  it("attaches partial output to abort errors", async () => {
    const { runtime } = setupRuntime();
    runtime.setMode(process.cwd(), "allow-all");
    const controller = new AbortController();
    const promise = runtime.execute({
      toolCallId: "test",
      command: "printf partial; sleep 1",
      signal: controller.signal,
      ctx: {
        cwd: process.cwd(),
        hasUI: true,
        sessionManager: { getSessionId: () => "test-session" },
      } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const abortError = (await promise.catch((error: unknown) => error)) as BashInterruptedError;
    expect(abortError).toBeInstanceOf(BashInterruptedError);
    expect(abortError).toMatchObject({
      kind: "aborted",
      name: "AbortError",
      message: "Command aborted by user",
    });
    expect(abortError.partial.output).toBe("partial");
    expect(abortError.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it("excludes the approval dialog wait from the aborted duration", async () => {
    const { runtime } = setupRuntime();
    runtime.setMode(process.cwd(), "workspace-write");
    const controller = new AbortController();
    // 审批弹窗停留 200ms 才放行：这段等待是用户 UI 操作，不属于命令运行时间
    const select = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return ALLOW_ONCE;
    });
    const promise = runtime.execute({
      toolCallId: "test",
      command: "printf partial; sleep 5",
      requestFullAccess: true,
      signal: controller.signal,
      ctx: fullAccessContext({ select, input: vi.fn() }, vi.fn(), process.cwd()),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const abortError = (await promise.catch((error: unknown) => error)) as BashInterruptedError;
    expect(select).toHaveBeenCalled();
    expect(abortError.kind).toBe("aborted");
    expect(abortError.elapsedMs).toBeLessThan(150);
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
    ).rejects.toThrow(/User denied unsandboxed execution/);
  });

  it("runs headless sessions under the configured mode instead of forcing readonly", async () => {
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"),
      JSON.stringify({ mode: "allow-all" }),
    );
    const { runtime } = setupRuntime();
    try {
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf runtime",
        ctx: {
          cwd: process.cwd(),
          hasUI: false,
          sessionManager: { getSessionId: () => "test-session" },
        } as never,
      });
      expect(result).toMatchObject({ exitCode: 0, output: "runtime" });
      // allow-all 不进沙箱：只有沙箱执行才会附沙箱状态块
      expect(result.sandboxHint).toBeUndefined();
    } finally {
      rmSync(join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"), { force: true });
    }
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

    it("shows only unallowed patterns in the edit submenu when part of a chain is pre-approved", async () => {
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
        .mockResolvedValueOnce(EDIT_RULES)
        .mockImplementationOnce(async (_title: string, options: string[]) => {
          // 子菜单只列出未允许的 `head *`，不含已允许的 `echo *`
          expect(options).toEqual(["☐ head *", BACK]);
          return "☐ head *";
        })
        .mockResolvedValueOnce(BACK)
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

    it("runs the command in the sandbox and reports it when the user picks Run this in sandbox", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async () => RUN_IN_SANDBOX);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf sandboxed",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }),
      });
      // 提权被拒：命令走沙箱执行路径，而不是审批放行的本地路径
      expect(bwrapOpsCreateMock).toHaveBeenCalled();
      expect(result).toMatchObject({ exitCode: 0, output: "sandboxed" });
      // 沙箱作用域由提醒块说明：不再附失败时的状态块（会再提示 dangerouslyDisableSandbox）
      expect(result.sandboxHint).toBeUndefined();
      expect(result.sandboxReminder).toMatchInlineSnapshot(`
        "<system-reminder>
        The user ran this command in the sandbox instead of approving unsandboxed execution: / is read-only, /tmp/ and ./ are writable, ./.git/ is read-only; network access is off.
        </system-reminder>"
      `);
    });

    it("does not persist allow rules when the user picks Run this in sandbox", async () => {
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-sandbox-choice-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      // 子菜单勾选了 pattern，但主决策是「在沙盒内执行」：allow 规则会自动放行非沙盒
      // 执行，与该选择矛盾，不持久化
      const select = vi
        .fn()
        .mockResolvedValueOnce(EDIT_RULES)
        .mockResolvedValueOnce("☐ printf *")
        .mockResolvedValueOnce(BACK)
        .mockResolvedValueOnce(RUN_IN_SANDBOX);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf choice",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }, undefined, directory),
      });
      expect(result).toMatchObject({ exitCode: 0, output: "choice" });
      expect(existsSync(join(directory, ".pi", "bwrap.json"))).toBe(false);
    });

    it("folds the persistable patterns behind the edit option instead of listing them", async () => {
      const { runtime } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const select = vi.fn(async (_title: string, options: string[]) => {
        // 主决策层只列动作：pattern 不再直接铺开，收进 Edit approval rules
        expect(options).toEqual([ALLOW_ONCE, RUN_IN_SANDBOX, DENY, DENY_WITH_REASON, EDIT_RULES]);
        return ALLOW_ONCE;
      });
      await runtime.execute({
        toolCallId: "test",
        command: "printf approved",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }),
      });
      expect(select).toHaveBeenCalledTimes(1);
    });

    it("returns to the main decision when the edit submenu is dismissed", async () => {
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-back-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      // 子菜单关闭（Esc）= 回到主菜单：未勾选任何规则，Allow once 放行且不写配置
      const select = vi
        .fn()
        .mockResolvedValueOnce(EDIT_RULES)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(ALLOW_ONCE);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf back",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }, undefined, directory),
      });
      expect(result).toMatchObject({ exitCode: 0, output: "back" });
      expect(existsSync(join(directory, ".pi", "bwrap.json"))).toBe(false);
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

    it("persists rules picked in the edit submenu and auto-approves next time", async () => {
      const directory = mkdtempSync(join(tmpdir(), "cc-bwrap-forever-"));
      const { runtime } = setupRuntime();
      runtime.setMode(directory, "workspace-write");
      // 主菜单 Edit approval rules → 勾选 `printf *`（☐ 前缀）→ Back → Allow once
      const select = vi
        .fn()
        .mockResolvedValueOnce(EDIT_RULES)
        .mockResolvedValueOnce("☐ printf *")
        .mockResolvedValueOnce(BACK)
        .mockResolvedValueOnce(ALLOW_ONCE);
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
      // 主菜单 Edit approval rules → 子菜单只勾选 `echo *` → Back → Allow once
      const select = vi
        .fn()
        .mockResolvedValueOnce(EDIT_RULES)
        .mockImplementationOnce(async (_title: string, options: string[]) => {
          expect(options).toEqual(["☐ echo *", "☐ head *", BACK]);
          return "☐ echo *";
        })
        .mockResolvedValueOnce(BACK)
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
      // 子菜单勾选 `printf *` 后回主菜单点 Deny：本次拒绝，但规则持久化为 allow
      const select = vi
        .fn()
        .mockResolvedValueOnce(EDIT_RULES)
        .mockResolvedValueOnce("☐ printf *")
        .mockResolvedValueOnce(BACK)
        .mockResolvedValueOnce(DENY);
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
        .mockResolvedValueOnce(EDIT_RULES)
        .mockResolvedValueOnce("☐ printf *")
        .mockResolvedValueOnce(BACK)
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

  describe("unsandboxed request policy", () => {
    it("denies a full-access request without a dialog after /bwrap-deny-request", async () => {
      const { runtime, pi } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      const { ctx, ui } = commandContext();
      await runBwrapCommand(pi, "bwrap-deny-request", ctx);
      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("denied without approval"),
        "info",
      );
      expect(ui.setStatus).toHaveBeenCalledWith(
        "bwrap",
        "bwrap: workspace-write (requests denied)",
      );

      const select = vi.fn();
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf nope",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input: vi.fn() }),
        }),
        // 与用户在审批框点 Deny（无理由）完全相同的错误
      ).rejects.toThrow("User denied unsandboxed execution.");
      expect(select).not.toHaveBeenCalled();
    });

    it("denies full-access requests even when an allow rule matches", async () => {
      writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"),
        JSON.stringify({ approvalRules: [{ action: "allow", pattern: "printf *" }] }),
      );
      const { runtime, pi } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      await runBwrapCommand(pi, "bwrap-deny-request", commandContext().ctx);

      const select = vi.fn();
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "printf allowed-by-rule",
          requestFullAccess: true,
          ctx: fullAccessContext({ select, input: vi.fn() }),
        }),
      ).rejects.toThrow("User denied unsandboxed execution.");
      expect(select).not.toHaveBeenCalled();
      rmSync(join(process.env.PI_CODING_AGENT_DIR!, "bwrap.json"), { force: true });
    });

    it("leaves sandboxed commands untouched while requests are denied", async () => {
      const { runtime, pi } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      await runBwrapCommand(pi, "bwrap-deny-request", commandContext().ctx);
      // 策略只作用于非沙盒请求：普通命令仍走沙箱路径（沙箱可用时正常完成，
      // bwrap 缺失时以安装提示失败），两种结果都不是策略拒绝
      const select = vi.fn();
      const outcome = await runtime
        .execute({
          toolCallId: "test",
          command: "printf sandboxed",
          ctx: fullAccessContext({ select, input: vi.fn() }),
        })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      expect(select).not.toHaveBeenCalled();
      expect(outcome).not.toBe("User denied unsandboxed execution.");
    });

    it("restores the approval dialog after /bwrap-allow-request", async () => {
      const { runtime, pi } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      await runBwrapCommand(pi, "bwrap-deny-request", commandContext().ctx);
      const { ctx, ui } = commandContext();
      await runBwrapCommand(pi, "bwrap-allow-request", ctx);
      expect(ui.notify).toHaveBeenCalledWith(
        "Non-sandbox requests require user approval again.",
        "info",
      );

      const select = vi.fn(async () => ALLOW_ONCE);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf back",
        requestFullAccess: true,
        ctx: fullAccessContext({ select, input: vi.fn() }),
      });
      expect(select).toHaveBeenCalled();
      expect(result).toMatchObject({ exitCode: 0, output: "back" });
    });

    it("announces the denied policy in the injected system prompt", async () => {
      const { pi } = setupRuntime();
      expect(beforeAgentStart(pi)).not.toContain("currently denied by the user");
      await runBwrapCommand(pi, "bwrap-deny-request", commandContext().ctx);
      expect(beforeAgentStart(pi)).toContain(
        "`dangerouslyDisableSandbox` and writes outside the workspace are refused without approval",
      );
    });

    it("broadcasts the switch to other entries' policy copies", async () => {
      // web_fetch 之类独立扩展入口各有自己的一份策略，只有经 pi.events 广播后
      // 同一开关才对它们生效（pi 给每个入口单独建 jiti 实例，模块级状态不共享）。
      const bus = createEventBus();
      const otherEntry = createRequestPolicy(bus);
      const { runtime, pi } = setupRuntime(createRequestPolicy(bus));
      runtime.setMode(process.cwd(), "workspace-write");

      await runBwrapCommand(pi, "bwrap-deny-request", commandContext().ctx);
      expect(otherEntry.deniesRequests()).toBe(true);
      // /bwrap-deny-request 的拒绝生效在其它入口的写入审批上
      expect(beforeAgentStart(pi)).toContain("currently denied by the user");

      await runBwrapCommand(pi, "bwrap-allow-request", commandContext().ctx);
      expect(otherEntry.deniesRequests()).toBe(false);
    });

    it("re-enables approval on the next session start", async () => {
      const { runtime, pi } = setupRuntime();
      runtime.setMode(process.cwd(), "workspace-write");
      await runBwrapCommand(pi, "bwrap-deny-request", commandContext().ctx);
      startSession(runtime, pi);
      expect(beforeAgentStart(pi)).not.toContain("currently denied");
    });
  });

  describe("fixed sandbox (explicit config)", () => {
    // 加载配置与创建解耦：创建时传入完整配置（如子代理元数据声明的 sandbox），
    // 沙箱随之固定——不注册 /bwrap-* 命令、非沙盒请求一律拒绝。
    const readonlyConfig: BwrapConfig = {
      mode: "readonly",
      writablePaths: [],
      extraWritablePaths: [],
      denyPaths: [],
      extraArgs: [],
      networkAllowlist: [],
    };

    it("registers no bwrap commands so the sandbox cannot be loosened", () => {
      const { pi } = setupRuntime(createRequestPolicy(), readonlyConfig);
      expect(pi.registerCommand).not.toHaveBeenCalled();
    });

    it("denies unsandboxed execution requests without a dialog", async () => {
      const { runtime } = setupRuntime(createRequestPolicy(), readonlyConfig);
      await expect(
        runtime.execute({
          toolCallId: "test",
          command: "echo escalate",
          requestFullAccess: true,
          ctx: fullAccessContext({}),
        }),
      ).rejects.toThrow(/User denied unsandboxed execution/);
    });

    it("runs under the declared config and omits the escape hatch hint", async () => {
      const { runtime } = setupRuntime(createRequestPolicy(), readonlyConfig);
      const result = await runtime.execute({
        toolCallId: "test",
        command: "printf fixed",
        ctx: {
          cwd: process.cwd(),
          hasUI: true,
          sessionManager: { getSessionId: () => "test-session" },
        } as never,
      });
      expect(result).toMatchObject({ exitCode: 0, output: "fixed" });
      expect(result.sandboxHint).toContain("the filesystem is read-only");
      expect(result.sandboxHint).not.toContain("dangerouslyDisableSandbox");
    });

    it("states the fixed mode and refused requests in the system prompt", () => {
      const { pi } = setupRuntime(createRequestPolicy(), readonlyConfig);
      expect(beforeAgentStart(pi)).toContain("fixed by the agent's declared sandbox config");
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
    ).rejects.toThrow(/User denied unsandboxed execution/);
  });
});

describe("describeSandbox", () => {
  const baseConfig: BwrapConfig = {
    mode: "workspace-write",
    writablePaths: [".", "/tmp"],
    extraWritablePaths: [],
    denyPaths: [],
    extraArgs: [],
    networkAllowlist: [],
  };
  function render(overrides: Partial<BwrapConfig>, unsandboxed = false): string | undefined {
    return describeSandbox(resolveBwrap({ ...baseConfig, ...overrides }), unsandboxed);
  }

  it("reports the default write boundary: / read-only, /tmp/ and ./ writable, ./.git/ read-only", () => {
    expect(render({})).toMatchInlineSnapshot(`
      "<system-reminder>
      This command ran in a sandbox: / is read-only, /tmp/ and ./ are writable, ./.git/ is read-only; network access is off.
      If the command needs more than that, use the \`dangerouslyDisableSandbox\` parameter to request unsandboxed execution; the user must approve this request.
      </system-reminder>"
    `);
  });

  it("reports read-only mode as a read-only filesystem", () => {
    expect(render({ mode: "readonly" })).toMatchInlineSnapshot(`
      "<system-reminder>
      This command ran in a sandbox: the filesystem is read-only; network access is off.
      If the command needs more than that, use the \`dangerouslyDisableSandbox\` parameter to request unsandboxed execution; the user must approve this request.
      </system-reminder>"
    `);
  });

  it("omits the unsandboxed escape hatch for a fixed sandbox", () => {
    const hint = describeSandbox(resolveBwrap({ ...baseConfig, mode: "readonly" }), false, true);
    expect(hint).toContain("the filesystem is read-only");
    expect(hint).not.toContain("dangerouslyDisableSandbox");
  });

  it("separates unrestricted network from an allowlist", () => {
    expect(render({ mode: "allow-net" })).toContain("network access is unrestricted");
    expect(render({ mode: "net-allowlist", networkAllowlist: ["example.com"] })).toContain(
      "network access is limited to allowlisted addresses",
    );
    // allowlist 域名不出现在提示里
    expect(render({ mode: "net-allowlist", networkAllowlist: ["example.com"] })).not.toContain(
      "example.com",
    );
  });

  it("ignores configured extra writable paths: the hint describes the default layout", () => {
    expect(
      render({
        writablePaths: ["."],
        extraWritablePaths: ["/data", "sub", "~/cache"],
      }),
    ).toMatchInlineSnapshot(`
      "<system-reminder>
      This command ran in a sandbox: / is read-only, /tmp/ and ./ are writable, ./.git/ is read-only; network access is off.
      If the command needs more than that, use the \`dangerouslyDisableSandbox\` parameter to request unsandboxed execution; the user must approve this request.
      </system-reminder>"
    `);
  });

  it("returns no hint when the command ran outside the sandbox", () => {
    expect(render({ mode: "workspace-write" }, true)).toBeUndefined();
    expect(render({ mode: "allow-all" }, true)).toBeUndefined();
  });
});
