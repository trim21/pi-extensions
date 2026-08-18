import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type AgentToolUpdateCallback,
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";

import { type CommandSpec, parseCommand } from "../lib/cli.js";
import {
  type CheckboxAction,
  type SelectAction,
  selectCheckboxActions,
  selectWithOptionalInput,
} from "../lib/ui.js";
import { type ApprovalRule, commandPatternsFor, evaluateBashApproval } from "./approval-rules.js";
import {
  type BwrapMode,
  createBwrapBashOperations,
  findBwrap,
  getBwrapConfigPaths,
  loadBwrapConfig,
  resolveBwrap,
  resolveBwrapPath,
  type ResolvedBwrap,
  resolveHeadlessBwrap,
} from "./core.js";
import { dcgSuggestion } from "./dcg-scan.js";

export type EscalationDecision = { kind: "dialog" } | { kind: "deny"; reason: string };

export function resolveEscalation(opts: { hasUI: boolean }): EscalationDecision {
  if (!opts.hasUI) {
    return {
      kind: "deny",
      reason:
        "request_full_access requires an interactive session with user approval; no UI is available in this session.",
    };
  }
  return { kind: "dialog" };
}

/** 全权限审批对话框的选项 label（也作为 switch 匹配键与测试引用）。 */
export const ALLOW_ONCE = "Allow once";
export const ALLOW_FOREVER = "Allow forever";
export const DENY = "Deny";
export const DENY_WITH_REASON = "Deny with reason";

/** 审批对话框选项：允许一次 / 永久允许 / 拒绝 / 拒绝并附理由。 */
export const FULL_ACCESS_CHOICES: readonly SelectAction[] = [
  { label: ALLOW_ONCE },
  { label: ALLOW_FOREVER },
  { label: DENY },
  { label: DENY_WITH_REASON, inputPrompt: "Why was this denied?" },
];

export interface BwrapExecutionRequest {
  toolCallId: string;
  command: string;
  timeout?: number;
  requestFullAccess?: boolean;
  requestFullAccessReason?: string;
  /** bash 工具显式传入的 workdir 参数；存在时审批对话框显示实际执行目录。 */
  workdir?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  ctx: ExtensionContext;
}

/**
 * 底层执行结果：完整退出码 + 截断后的输出文本。
 * 输出在运行时就直接写入 agent-dir/tmp/{uuid}.txt（完整内容），内存不保留全量；
 * `truncation.totalLines/totalBytes` 是精确统计值（非尾部缓冲的）。
 * 退出码语义由上层 Bash 工具解释，这里不做成败判定。
 */
export interface BwrapExecutionResult {
  exitCode: number | null;
  /** 截断后的输出（尾部），未截断时为完整输出；空输出为空字符串。 */
  output: string;
  /** 完整输出的文件路径；无输出时不存在。 */
  fullOutputPath?: string;
  truncation: TruncationResult;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fenceCodeBlock(code: string): string {
  const longestRun = Math.max(...(code.match(/`+/g)?.map((match) => match.length) ?? [0]));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${code}\n${fence}`;
}

/** 进度推送的节流间隔（对齐 pi 内置 bash 工具的 100ms）。 */
const BASH_UPDATE_THROTTLE_MS = 100;
/** 进度快照只保留尾部内容，避免大输出每 100ms 全量推给 TUI。 */
const BASH_UPDATE_TAIL_BYTES = 64 * 1024;
/** 内存尾部缓冲上限：必须大于 truncateTail 的默认上限（50KB / 2000 行）。 */
const BASH_TAIL_LIMIT_BYTES = 1024 * 1024;

function countNewlines(data: Buffer): number {
  let count = 0;
  for (const byte of data) {
    if (byte === 0x0a) count++;
  }
  return count;
}

/**
 * 合并 stdout/stderr 的流式输出累积器：输出在运行时就直接写入
 * agent-dir/tmp/{uuid}.txt（完整内容），内存只保留尾部缓冲。
 * 大输出不会撑爆内存；最终结果只返回截断后的文本。
 */
class BashOutput {
  private stream: WriteStream | undefined;
  private writeError: Error | undefined;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private totalBytes = 0;
  private totalLines = 0;
  filePath: string | undefined;

  append(data: Buffer): void {
    this.totalBytes += data.length;
    this.totalLines += countNewlines(data);
    if (!this.stream) {
      const dir = join(getAgentDir(), "tmp");
      mkdirSync(dir, { recursive: true });
      this.filePath = join(dir, `${randomUUID()}.txt`);
      this.stream = createWriteStream(this.filePath, { flags: "w" });
      this.stream.on("error", (error) => {
        this.writeError = error;
      });
    }
    this.stream.write(data);
    this.tail.push(data);
    this.tailBytes += data.length;
    while (this.tailBytes > BASH_TAIL_LIMIT_BYTES && this.tail.length > 1) {
      this.tailBytes -= this.tail[0].length;
      this.tail.shift();
    }
    if (this.tailBytes > BASH_TAIL_LIMIT_BYTES && this.tail.length === 1) {
      // 单个 chunk 超过上限：截掉头部，只保留尾部
      this.tail[0] = this.tail[0].subarray(this.tailBytes - BASH_TAIL_LIMIT_BYTES);
      this.tailBytes = BASH_TAIL_LIMIT_BYTES;
    }
  }

  close(): Promise<void> {
    if (!this.stream) return Promise.resolve();
    const stream = this.stream;
    this.stream = undefined;
    return new Promise((resolve) => {
      stream.end(() => {
        if (this.writeError) {
          // 落盘失败（如 readonly 沙箱）：降级为纯内存模式，命令仍正常返回
          this.filePath = undefined;
        }
        resolve();
      });
    });
  }

  /** 尾部文本（截断结果的候选，未截断时即完整输出）。 */
  tailText(): string {
    return Buffer.concat(this.tail, this.tailBytes).toString("utf8");
  }

  get stats(): { totalBytes: number; totalLines: number } {
    return { totalBytes: this.totalBytes, totalLines: this.totalLines };
  }

  /** 尾部快照（用于流式进度显示）。 */
  tailSnapshot(): string {
    let remaining = BASH_UPDATE_TAIL_BYTES;
    const tail: Buffer[] = [];
    for (let i = this.tail.length - 1; i >= 0 && remaining > 0; i--) {
      const chunk = this.tail[i];
      if (chunk.length <= remaining) {
        tail.unshift(chunk);
        remaining -= chunk.length;
      } else {
        tail.unshift(chunk.subarray(chunk.length - remaining));
        remaining = 0;
      }
    }
    return Buffer.concat(tail).toString("utf8");
  }
}

function notifyMode(
  ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } },
  mode: BwrapMode,
): void {
  const labels: Record<BwrapMode, string> = {
    "allow-all": "allow-all: sandbox off, network on",
    "workspace-write": "workspace-write: sandbox on, network off",
    "allow-net": "allow-net: sandbox on, network on, workspace writable",
    readonly: "readonly: sandbox on, network off, read-only fs",
  };
  ctx.ui.notify(labels[mode], "info");
}

export class BwrapRuntime {
  private resolved: ResolvedBwrap | undefined;
  private sandboxDisabled = false;
  private bwrapUnavailable = false;

  setup(pi: ExtensionAPI): void {
    pi.registerFlag("no-bwrap", {
      description: "Disable bwrap sandboxing for bash commands",
      type: "boolean",
      default: false,
    });

    pi.on("session_start", (_event, ctx) => {
      this.sandboxDisabled = pi.getFlag("no-bwrap") === true && ctx.hasUI;
      this.resolved = undefined;
      this.bwrapUnavailable = false;
      if (process.platform === "win32") {
        // Windows 没有 bubblewrap：不做 bwrap 检测、不显示 bwrap 状态，
        // 每条 bash 命令在 execute 时逐条人工审批，模型无需知道 bwrap 的存在。
        ctx.ui.notify("Every bash command requires user approval before it runs.", "info");
        return;
      }
      const runtime = this.resolve(ctx);
      if (runtime.bwrapEnabled) {
        try {
          findBwrap(runtime.bwrapPath);
        } catch (error) {
          // Fail closed: a missing bwrap binary must not silently degrade to an
          // unsandboxed allow-all session. Commands are refused until the user
          // explicitly opts out via --no-bwrap or the bwrap-allow-all command.
          this.bwrapUnavailable = true;
          this.resolved = undefined;
          ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("error", "bwrap: unavailable"));
          ctx.ui.notify(error instanceof Error ? error.message : "bwrap not found", "error");
          return;
        }
      }
      ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${runtime.mode}`));
      ctx.ui.notify(
        runtime.bwrapEnabled
          ? `bwrap initialized (${runtime.mode})`
          : `bwrap mode: ${runtime.mode}`,
        "info",
      );
    });

    pi.on("session_shutdown", () => {
      this.reset();
    });

    pi.on("before_agent_start", (event, ctx) => {
      const runtime = this.resolve(ctx);
      const isWindows = process.platform === "win32";
      const modeText = ctx.hasUI
        ? isWindows
          ? "Every bash command requires user approval before it runs."
          : `Current bwrap mode: **${runtime.mode}**. The bwrap runtime selects sandboxing and, when requested, user approval for unsandboxed execution.`
        : isWindows
          ? "This headless session cannot approve commands: bash commands are refused."
          : "This headless session is forced into bwrap readonly mode. Unsandboxed execution cannot be approved.";
      const unavailableText =
        !isWindows && this.bwrapUnavailable
          ? " bwrap is unavailable (binary not found): bash commands are refused unless the user explicitly approves unsandboxed execution."
          : "";
      return {
        systemPrompt:
          event.systemPrompt + `\n\n## Command Execution\n${modeText}${unavailableText}\n`,
      };
    });

    this.registerCommands(pi);
  }

  setMode(cwd: string, mode: BwrapMode): ResolvedBwrap {
    this.resolved = resolveBwrap({ ...loadBwrapConfig(cwd), mode });
    this.sandboxDisabled = false;
    return this.resolved;
  }

  reset(): void {
    this.resolved = undefined;
    this.sandboxDisabled = false;
    this.bwrapUnavailable = false;
  }

  async execute(request: BwrapExecutionRequest): Promise<BwrapExecutionResult> {
    const runtime = this.resolve(request.ctx);
    const isWindows = process.platform === "win32";
    // 非 Windows：bwrap 缺失时 fail closed，普通命令一律拒绝（除非显式 full-access 审批）。
    // Windows：没有 bubblewrap，这是预期状态，降级为每条命令都走人工审核。
    if (
      !isWindows &&
      this.bwrapUnavailable &&
      runtime.bwrapEnabled &&
      request.requestFullAccess !== true
    ) {
      throw new Error(
        "bwrap (bubblewrap) not found; refusing to execute commands without sandboxing. " +
          "Install bubblewrap and restart the session, or pass --no-bwrap to disable the sandbox explicitly.",
      );
    }
    // 需要人工审批：非 Windows 仅 requestFullAccess；Windows 上默认所有命令
    // （allow-all 模式是显式 opt-out，仍直接执行）。
    const needsApproval = request.requestFullAccess === true || (isWindows && runtime.bwrapEnabled);
    if (needsApproval && runtime.bwrapEnabled) {
      // 先按 approvalRules 自动判定：allow 直接放行，deny 直接拒绝，未命中才弹框
      const decision = await evaluateBashApproval(request.command, runtime.approvalRules);
      if (decision === "deny") {
        throw new Error(`Command denied by bwrap approval rule: ${request.command}`);
      }
      if (decision === undefined) {
        await this.approveFullAccess(
          request.ctx,
          request.command,
          request.requestFullAccessReason,
          request.workdir,
        );
      }
    }
    const operations =
      isWindows || needsApproval || !runtime.bwrapEnabled
        ? createLocalBashOperations()
        : createBwrapBashOperations(runtime);
    const output = new BashOutput();
    const { onUpdate } = request;

    // 流式进度：节流推送尾部快照（对齐 pi 内置 bash 的实时输出体验）
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    let lastUpdateAt = 0;
    const emitUpdate = () => {
      if (!onUpdate || !dirty) return;
      dirty = false;
      lastUpdateAt = Date.now();
      onUpdate({
        content: [{ type: "text", text: output.tailSnapshot() }],
        details: undefined,
      });
    };
    const scheduleUpdate = () => {
      if (!onUpdate) return;
      dirty = true;
      const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
      if (delay <= 0) {
        if (updateTimer) clearTimeout(updateTimer);
        updateTimer = undefined;
        emitUpdate();
        return;
      }
      if (updateTimer) return;
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        emitUpdate();
      }, delay);
    };

    try {
      if (onUpdate) onUpdate({ content: [], details: undefined });
      const { exitCode } = await operations.exec(request.command, request.ctx.cwd, {
        onData: (data) => {
          output.append(data);
          scheduleUpdate();
        },
        signal: request.signal,
        timeout: request.timeout,
      });
      await output.close();
      const truncation = truncateTail(output.tailText());
      return {
        exitCode,
        output: truncation.content,
        ...(output.filePath && { fullOutputPath: output.filePath }),
        // 用精确统计值覆盖尾部缓冲的估算（提示文本的行数/字节数要准确）
        truncation: { ...truncation, ...output.stats },
      };
    } catch (error) {
      // 底层统一把超时/中断转成可读文案（对齐 pi 内置 bash 工具）
      if (error instanceof Error && error.message.startsWith("timeout:")) {
        throw new Error(
          `Command timed out after ${error.message.slice("timeout:".length)} seconds`,
          { cause: error },
        );
      }
      if (error instanceof Error && error.message === "aborted") {
        throw new Error("Command aborted", { cause: error });
      }
      throw error;
    } finally {
      if (updateTimer) clearTimeout(updateTimer);
      if (onUpdate && dirty) emitUpdate();
      await output.close();
    }
  }

  private resolve(ctx: Pick<ExtensionContext, "cwd" | "hasUI">): ResolvedBwrap {
    const config = loadBwrapConfig(ctx.cwd);
    if (!ctx.hasUI) return resolveHeadlessBwrap(config);
    if (this.sandboxDisabled) return resolveBwrap({ ...config, mode: "allow-all" });
    if (!this.resolved) this.resolved = resolveBwrap(config);
    return this.resolved;
  }

  private async approveFullAccess(
    ctx: ExtensionContext,
    command: string,
    reason: string | undefined,
    workdir?: string,
  ): Promise<void> {
    const policy = resolveEscalation({ hasUI: ctx.hasUI });
    if (policy.kind === "deny") throw new Error(policy.reason);
    // 弹框前解析命令的持久化规则（勾选的 pattern 会写入），在弹框里以
    // checkbox 列出：`echo 1 | head` → `echo *`、`head *`，逐项决定是否
    // allow forever，避免用户对"永久允许"持久化什么一无所知。
    const patterns = await commandPatternsFor(command);
    // dcg 扫描建议是可选的参考文本：未安装时静默跳过；已安装但扫描失败
    // 时 notify 提示，弹窗本身与无 dcg 时一致
    const outcome = await dcgSuggestion(command);
    if (outcome.kind === "failed") {
      ctx.ui.notify(`dcg 扫描失败，本次无破坏性命令建议: ${outcome.detail}`, "warning");
    }
    // 弹框主体按行组织（'\n' join），便于 review；suggestion 与规则说明
    // 块带前导空行 + 尾部 "---" 分隔，输出与历史逐字符一致。
    const lines: string[] = [
      "Allow this command to run without sandbox?",
      "---",
      "",
      `Reason: ${escapeHtml(reason ?? "(No reason provided by model)")}`,
      "---",
    ];
    if (outcome.kind === "suggestion") {
      lines.push("", outcome.suggestion.text, "---");
    }
    if (patterns.length > 0) {
      lines.push("", "勾选规则将永久允许（allow forever），未勾选规则仅本次放行:", "---");
    }
    lines.push(fenceCodeBlock(command));
    // workdir 存在时展示实际执行目录（ctx.cwd 已被 bash 工具解析为绝对路径）
    if (workdir) {
      lines.push(`Workdir: ${escapeHtml(ctx.cwd)}`);
    }
    const description = lines.join("\n");

    // 解析失败（无 pattern 可勾选）：保持单选对话框（Allow forever 是空操作）
    if (patterns.length === 0) {
      // 单选：允许一次 / 永久允许（写入规则）/ 拒绝 / 拒绝并附理由（弹输入框）
      const verdict = await selectWithOptionalInput(description, FULL_ACCESS_CHOICES, ctx.ui, {
        signal: ctx.signal,
      });
      // 关闭对话框 = 中断并拒绝，不循环重问
      if (verdict === undefined) {
        ctx.abort();
        throw new Error("User denied the command execution.");
      }
      switch (verdict.label) {
        case ALLOW_ONCE: {
          return;
        }
        case ALLOW_FOREVER: {
          await this.persistAllowRule(ctx, command, patterns);
          return;
        }
        case DENY: {
          throw new Error("User denied unsandboxed execution.");
        }
        case DENY_WITH_REASON: {
          const feedback = verdict.input?.trim() ?? "";
          throw new Error(
            feedback
              ? `User denied unsandboxed execution: ${feedback}`
              : "User denied unsandboxed execution.",
          );
        }
      }
    }

    // 每个识别到的 pattern 一个 checkbox：勾选 = 该规则 allow forever。
    // Allow once = 执行本次并持久化勾选的规则；Deny 系列不持久化任何规则。
    const actions = [
      { action: "allow-once", label: ALLOW_ONCE },
      { action: "deny", label: DENY },
      {
        action: "deny-with-reason",
        label: DENY_WITH_REASON,
        inputPrompt: "Why was this denied?",
      },
    ] as const satisfies readonly CheckboxAction<"allow-once" | "deny" | "deny-with-reason">[];
    const verdict = await selectCheckboxActions(
      description,
      [...new Set(patterns)].map((pattern) => ({ label: pattern })),
      actions,
      ctx.ui,
      { signal: ctx.signal },
    );
    // 关闭对话框 = 中断并拒绝，不循环重问
    if (verdict === undefined) {
      ctx.abort();
      throw new Error("User denied the command execution.");
    }
    switch (verdict.action) {
      case "allow-once": {
        if (verdict.selected.length > 0) {
          await this.persistAllowRule(ctx, command, verdict.selected);
        }
        return;
      }
      case "deny": {
        throw new Error("User denied unsandboxed execution.");
      }
      case "deny-with-reason": {
        const feedback = verdict.input?.trim() ?? "";
        throw new Error(
          feedback
            ? `User denied unsandboxed execution: ${feedback}`
            : "User denied unsandboxed execution.",
        );
      }
    }
  }

  /** 把命令的权限模式写入项目 bwrap.json 的 approvalRules（allow forever）。 */
  private async persistAllowRule(
    ctx: ExtensionContext,
    command: string,
    patterns?: string[],
  ): Promise<void> {
    const rulePatterns = patterns ?? (await commandPatternsFor(command));
    if (rulePatterns.length === 0) return; // 解析失败：本次放行，不写规则
    const newRules: ApprovalRule[] = rulePatterns.map((pattern) => ({ action: "allow", pattern }));
    const { project } = getBwrapConfigPaths(ctx.cwd);
    let config: Record<string, unknown> = {};
    if (existsSync(project)) {
      config = JSON.parse(readFileSync(project, "utf8")) as Record<string, unknown>;
    }
    const existing = Array.isArray(config.approvalRules)
      ? (config.approvalRules as ApprovalRule[])
      : [];
    config.approvalRules = [...existing, ...newRules];
    await mkdir(dirname(project), { recursive: true });
    await writeFile(project, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    // 更新缓存的规则，立即生效
    if (this.resolved) {
      this.resolved.approvalRules = [...this.resolved.approvalRules, ...newRules];
    }
  }

  private registerCommands(pi: ExtensionAPI): void {
    const specs = {
      bwrap: {
        name: "bwrap",
        usage: "",
        description: "Show bwrap sandbox configuration",
        flags: Type.Object({}),
      },
      "bwrap-allow-all": {
        name: "bwrap-allow-all",
        usage: "",
        description: "Disable bwrap sandbox, full access",
        flags: Type.Object({}),
      },
      "bwrap-workspace-write": {
        name: "bwrap-workspace-write",
        usage: "",
        description: "Sandbox on, network off, workspace writable",
        flags: Type.Object({}),
      },
      "bwrap-allow-net": {
        name: "bwrap-allow-net",
        usage: "",
        description: "Sandbox on, network on, workspace writable",
        flags: Type.Object({}),
      },
      "bwrap-readonly": {
        name: "bwrap-readonly",
        usage: "",
        description: "Sandbox on, network off, no writes",
        flags: Type.Object({}),
      },
    } as const satisfies Record<string, CommandSpec<TObject>>;

    pi.registerCommand("bwrap", {
      description: specs.bwrap.description,
      handler: (args, ctx) =>
        this.runCommand(pi, specs.bwrap, args, ctx, (commandCtx) => {
          const runtime = this.resolve(commandCtx);
          if (this.bwrapUnavailable) {
            commandCtx.ui.notify(
              "bwrap is unavailable: binary not found. Commands are refused unless sandboxing is explicitly disabled.",
              "error",
            );
            return;
          }
          if (!runtime.bwrapEnabled) {
            commandCtx.ui.notify(`bwrap disabled (mode: ${runtime.mode})`, "info");
            return;
          }
          const writable = runtime.writablePaths.map((path) =>
            resolveBwrapPath(path, commandCtx.cwd),
          );
          const tmpfs = runtime.tmpfsPaths.map((path) => resolveBwrapPath(path, commandCtx.cwd));
          commandCtx.ui.notify(
            `bwrap ${runtime.mode} ${runtime.network ? "net" : "no-net"} write:[${writable.join(", ")}] tmpfs:[${tmpfs.join(", ") || "-"}]`,
            "info",
          );
        }),
    });

    for (const [name, mode] of [
      ["bwrap-allow-all", "allow-all"],
      ["bwrap-workspace-write", "workspace-write"],
      ["bwrap-allow-net", "allow-net"],
      ["bwrap-readonly", "readonly"],
    ] as const) {
      pi.registerCommand(name, {
        description: specs[name].description,
        handler: (args, ctx) =>
          this.runCommand(pi, specs[name], args, ctx, (commandCtx) =>
            this.switchMode(pi, mode, commandCtx),
          ),
      });
    }
  }

  private switchMode(pi: ExtensionAPI, mode: BwrapMode, ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) {
      ctx.ui.notify("bwrap mode cannot be changed without an interactive UI", "warning");
      return;
    }
    this.setMode(ctx.cwd, mode);
    ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${mode}`));
    notifyMode(ctx, mode);
    pi.sendMessage({
      customType: "info",
      content: `Bwrap sandbox mode changed to "${mode}".`,
      display: true,
    });
  }

  private runCommand(
    pi: ExtensionAPI,
    spec: CommandSpec<TObject>,
    args: string,
    ctx: ExtensionCommandContext,
    run: (ctx: ExtensionCommandContext) => void | Promise<void>,
  ): Promise<void> {
    const parsed = parseCommand(spec, args);
    if (parsed.kind !== "ok") {
      pi.sendMessage({ customType: "info", content: parsed.text, display: true });
      return Promise.resolve();
    }
    return Promise.resolve(run(ctx));
  }
}

export function createBwrapRuntime(): BwrapRuntime {
  return new BwrapRuntime();
}
