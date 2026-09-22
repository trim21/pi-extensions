import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { throttle } from "lodash-es";
import { type TObject, Type } from "typebox";

import { type CommandSpec, parseCommand } from "../lib/cli.js";
import { fenceCodeBlock } from "../lib/markdown.js";
import { formatDisplayPath } from "../lib/path.js";
import { createRequestPolicy, type RequestPolicy } from "../lib/request-policy.js";
import { type SelectAction, selectMultiple, selectWithOptionalInput } from "../lib/ui.js";
import { type ApprovalRule, evaluateBashApproval, matchRule } from "./approval-rules.js";
import { commandPatternsFor } from "./approval-suggest.js";
import {
  type BwrapMode,
  findBwrap,
  findMihomo,
  getBwrapConfigPaths,
  loadBwrapConfig,
  resolveBwrap,
  resolveBwrapPath,
  type ResolvedBwrap,
} from "./core.js";
import { dcgSuggestion } from "./dcg-scan.js";
import { loadSandboxConfig, runInSandbox } from "./sandbox.js";

/** 全权限审批对话框的选项 label（也作为 switch 匹配键与测试引用）。 */
export const ALLOW_ONCE = "Allow once";
/** 拒绝提权、命令降级为在沙盒内执行。 */
export const RUN_IN_SANDBOX = "Run this in sandbox";
export const DENY = "Deny";
export const DENY_WITH_REASON = "Deny with reason";
/** 第一层的折叠入口：进入按 pattern 勾选持久化规则的子菜单。 */
export const EDIT_RULES = "Edit approval rules";
/** 规则子菜单的返回项：结束勾选，回到第一层做放行/拒绝决策。 */
export const BACK = "Back";

/**
 * 全权限审批 UI 的决策结果：业务层（execute/approveFullAccess）据此
 * 决定放行、拒绝并持久化勾选的规则，UI 层不直接产生副作用。
 */
export interface FullAccessUIDecision {
  /** 用户选择的动作 label（ALLOW_ONCE / RUN_IN_SANDBOX / DENY / DENY_WITH_REASON）。 */
  result: string;
  /** 用户勾选、需持久化为 allow 规则的 pattern；未勾选时为空数组。 */
  foreverApprovedPattern: string[];
  /** DENY_WITH_REASON 时用户输入的理由。 */
  reason?: string;
}

/**
 * 全权限审批的放行结果：允许一次性全权限执行，或用户拒绝提权、
 * 命令降级为在沙盒内执行（输出后附系统提醒）。
 */
type FullAccessGrant = "full-access" | "sandbox";

export interface BwrapExecutionRequest {
  toolCallId: string;
  command: string;
  timeout?: number;
  requestFullAccess?: boolean;
  description?: string;
  /** 解析后的实际执行目录；缺省时与 ctx.cwd 相同。ctx.cwd 始终是 session 工作区。 */
  cwd?: string;
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
  /** 用户选「Run this in sandbox」拒绝提权时的系统提醒，成功与失败都由上层附上；其余情况缺省。 */
  sandboxReminder?: string;
  /** 沙箱状态说明（写边界 + 网络层级），失败时由上层工具作为独立信息块附上；未沙箱执行时为 undefined。 */
  sandboxHint: string | undefined;
  /** 截断后的输出（尾部），未截断时为完整输出；空输出为空字符串。 */
  output: string;
  /** 完整输出的文件路径；无输出时不存在。 */
  fullOutputPath?: string;
  truncation: TruncationResult;
}

/**
 * 超时/中断时命令终止前已捕获的部分输出快照（截断后的文本 + 落盘信息）。
 * 展示格式（输出在前、状态在最后）由上层 Bash 工具按各自风格拼接。
 */
export interface BashExecutionPartial {
  output: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
}

/** 命令超时或中断（abort signal）时抛出的错误，携带部分输出供上层展示。 */
export class BashInterruptedError extends Error {
  readonly kind: "timeout" | "aborted";
  readonly partial: BashExecutionPartial;
  readonly sandboxHint: string | undefined;
  /** 用户选「Run this in sandbox」拒绝提权时的系统提醒；其余情况为 undefined。 */
  readonly sandboxReminder: string | undefined;
  /**
   * 命令实际运行时长（毫秒）：从审批结束、命令真正开始执行算到终止，
   * 不含审批弹窗等用户 UI 交互耗时。
   */
  readonly elapsedMs: number;

  constructor(
    kind: "timeout" | "aborted",
    message: string,
    partial: BashExecutionPartial,
    sandboxHint: string | undefined,
    elapsedMs: number,
    cause: unknown,
    sandboxReminder?: string,
  ) {
    super(message, { cause });
    this.kind = kind;
    this.partial = partial;
    this.sandboxHint = sandboxHint;
    this.sandboxReminder = sandboxReminder;
    this.elapsedMs = elapsedMs;
    // 对齐标准错误分类：中断=AbortError（用户取消），超时=TimeoutError
    this.name = kind === "aborted" ? "AbortError" : "TimeoutError";
  }
}

/** 命令运行时长的展示文案（秒，一位小数），超时/中断状态文本共用。 */
export function formatElapsedSeconds(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)} seconds`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
 * agent-dir/tmp/{sessionId}/{uuid}.txt（完整内容），内存只保留尾部缓冲。
 * 大输出不会撑爆内存；最终结果只返回截断后的文本。
 */
class BashOutput {
  private stream: WriteStream | undefined;
  private writeError: Error | undefined;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private totalBytes = 0;
  private totalLines = 0;
  private readonly sessionId: string;
  filePath: string | undefined;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  append(data: Buffer): void {
    this.totalBytes += data.length;
    this.totalLines += countNewlines(data);
    if (!this.stream) {
      const dir = join(getAgentDir(), "tmp", this.sessionId);
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

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
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
    "net-allowlist": "net-allowlist: sandbox on, network filtered by allowlist",
    readonly: "readonly: sandbox on, network off, read-only fs",
  };
  ctx.ui.notify(labels[mode], "info");
}

/** 沙箱默认写边界：根只读、工作区与 /tmp 可写、.git 只读。不展开用户配置的额外可写路径。 */
const SANDBOX_WRITE_RULES = "/ is read-only, /tmp/ and ./ are writable, ./.git/ is read-only";

/** 网络层级：关 / 只放行白名单 / 完全放开（白名单域名本身不列出，对判断失败无用）。 */
function describeNetwork(resolved: ResolvedBwrap): string {
  if (!resolved.network) return "network access is off";
  if (resolved.networkAllowlist.length > 0)
    return "network access is limited to allowlisted addresses";
  return "network access is unrestricted";
}

/** 沙箱作用域一句话：写边界 + 网络层级（沙箱状态块与沙盒内执行提醒共用）。 */
function describeLimits(resolved: ResolvedBwrap): string {
  const writes = resolved.mode === "readonly" ? "the filesystem is read-only" : SANDBOX_WRITE_RULES;
  return `${writes}; ${describeNetwork(resolved)}`;
}

/**
 * 用户无理由拒绝非沙盒请求的文案。`/bwrap-deny-request` 生效时与无 UI 会话里
 * 需要审批的请求，都必须与用户在审批框点 Deny 完全一致——模型看到的是一次
 * 普通拒绝，而不是另一套错误语义。
 */
const UNSANDBOXED_DENIED = "User denied unsandboxed execution.";

/** 命令没经沙箱时沿用 prompt 里的说法，给出在沙盒外重跑的手段。 */
const SANDBOX_ESCAPE_HATCH =
  "If the command needs more than that, use the `dangerouslyDisableSandbox` parameter to request unsandboxed execution; the user must approve this request.";

/**
 * 命令失败时作为独立信息块附上的沙箱状态：默认写边界 + 网络层级，以及在沙盒外重跑的手段。
 * 写边界只说沙箱布局（不展开用户配置的可写路径），网络只说层级（不列白名单域名）。
 * 整块包在 `<system-reminder>` 里，与其它系统注入的提示同一形态，模型不会把它当成命令输出。
 * 命令没经沙箱（allow-all、审批通过的全权限、Windows）时返回 undefined：
 * 没有沙箱就没什么可提示的。
 */
export function describeSandbox(resolved: ResolvedBwrap, unsandboxed: boolean): string | undefined {
  if (unsandboxed) return undefined;
  return [
    "<system-reminder>",
    `This command ran in a sandbox: ${describeLimits(resolved)}.`,
    SANDBOX_ESCAPE_HATCH,
    "</system-reminder>",
  ].join("\n");
}

/**
 * 用户在审批框选「Run this in sandbox」拒绝提权后，命令输出后附带的系统提醒：
 * 说明命令在沙盒内执行及其作用域，成功与失败都附上。此时 describeSandbox 的
 * 状态块不再附——提权请求刚被用户拒绝，再提示 dangerouslyDisableSandbox 只会
 * 诱导重复请求，作用域描述由本提醒承担。
 */
export function describeSandboxChoice(resolved: ResolvedBwrap): string {
  return [
    "<system-reminder>",
    `The user ran this command in the sandbox instead of approving unsandboxed execution: ${describeLimits(resolved)}.`,
    "</system-reminder>",
  ].join("\n");
}

/** 失败结果里附加的沙箱状态块；未沙箱执行（hint 为 undefined）时没有这一块。 */
export function sandboxHintBlock(hint: string | undefined): { type: "text"; text: string }[] {
  return hint === undefined ? [] : [{ type: "text", text: hint }];
}

export class BwrapRuntime {
  private resolved: ResolvedBwrap | undefined;
  private bwrapUnavailable = false;
  /** net-allowlist 首次执行时解析一次 mihomo 路径，之后随 runtime 复用，不逐命令扫描 PATH。 */
  private mihomoPath: string | undefined;
  /**
   * 非沙盒请求策略由创建方注入：聚合入口把它与文件工具的 write-guard 共享同一实例，
   * 独立入口各持一份、经 pi.events 同步。
   */
  private readonly policy: RequestPolicy;

  constructor(policy: RequestPolicy) {
    this.policy = policy;
  }

  setup(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
      this.resolved = undefined;
      this.bwrapUnavailable = false;
      this.policy.setDenyRequests(false);
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
          // explicitly opts out via the bwrap-allow-all command.
          this.bwrapUnavailable = true;
          this.resolved = undefined;
          ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("error", "bwrap: unavailable"));
          ctx.ui.notify(error instanceof Error ? error.message : "bwrap not found", "error");
          return;
        }
      }
      ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", this.statusLabel(runtime.mode)));
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
        : `Current bwrap mode: **${runtime.mode}**. This headless session cannot ask for approval: commands that require user approval are denied.`;
      const unavailableText =
        !isWindows && this.bwrapUnavailable
          ? " bwrap is unavailable (binary not found): bash commands are refused unless the user explicitly approves unsandboxed execution."
          : "";
      const denyRequestsText =
        !isWindows && this.policy.deniesRequests()
          ? " Unsandboxed execution is currently denied by the user: `dangerouslyDisableSandbox` and writes outside the workspace are refused without approval."
          : "";
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n## Command Execution\n${modeText}${unavailableText}${denyRequestsText}\n`,
      };
    });

    this.registerCommands(pi);
  }

  setMode(cwd: string, mode: BwrapMode): ResolvedBwrap {
    this.resolved = loadSandboxConfig({ workspace: cwd, mode });
    return this.resolved;
  }

  reset(): void {
    this.resolved = undefined;
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
          "Install bubblewrap and restart the session, or disable the sandbox explicitly with /bwrap-allow-all.",
      );
    }
    // workspace 恒为 session 工作区；cwd 只是本次命令的进程执行目录，
    // 二者解耦后 workdir 参数无法把沙箱可写边界带出工作区。
    const workspace = request.ctx.cwd;
    const execCwd = request.cwd ?? workspace;
    // 需要人工审批：非 Windows 仅 requestFullAccess；Windows 上默认所有命令
    // （allow-all 模式是显式 opt-out，仍直接执行）。
    const needsApproval = request.requestFullAccess === true || (isWindows && runtime.bwrapEnabled);
    // 用户在审批框选「Run this in sandbox」拒绝提权：命令降级为沙盒内执行
    let userChoseSandbox = false;
    if (needsApproval && runtime.bwrapEnabled) {
      // /bwrap-deny-request：非沙盒请求直接拒绝——审批规则与审批框都不再参与，
      // 拒绝文案与用户点 Deny 相同，直到用户用 /bwrap-allow-request 恢复审批。
      if (request.requestFullAccess === true && this.policy.deniesRequests()) {
        throw new Error(UNSANDBOXED_DENIED);
      }
      // 先按 approvalRules 自动判定：allow 直接放行，deny 直接拒绝，未命中才弹框
      const decision = await evaluateBashApproval(request.command, runtime.approvalRules);
      if (decision === "deny") {
        throw new Error(`Command denied by bwrap approval rule: ${request.command}`);
      }
      if (decision === undefined) {
        userChoseSandbox =
          (await this.approveFullAccess(
            request.ctx,
            request.command,
            request.description,
            execCwd,
          )) === "sandbox";
      }
    }
    // 不经沙箱的三种情形：Windows（无 bubblewrap）、审批通过的全权限、allow-all 模式；
    // 例外是用户选「Run this in sandbox」：提权被拒，命令照常进沙箱
    const local = !userChoseSandbox && (isWindows || needsApproval || !runtime.bwrapEnabled);
    // mihomoPath 是 ResolvedBwrap 的 override 语义：首次 net-allowlist 执行时解析
    // 一次存入私有字段，之后写回 resolved 直达 createNetworkStack，不逐命令扫描 PATH
    if (runtime.network && runtime.networkAllowlist.length > 0) {
      runtime.mihomoPath ??= this.mihomoPath ?? findMihomo();
      this.mihomoPath = runtime.mihomoPath;
    }
    // 命令失败时附带的沙箱状态（写边界 + 网络层级），由上层拼进错误文本。
    // 用户选「Run this in sandbox」时不附：沙箱作用域改由 sandboxReminder 说明
    const sandboxHint = userChoseSandbox ? undefined : describeSandbox(runtime, local);
    // 提权被拒、命令在沙盒内执行的系统提醒：成功与失败都由上层附上
    const sandboxReminder = userChoseSandbox ? describeSandboxChoice(runtime) : undefined;
    // 计时起点放在审批之后：审批弹窗的等待时长属于用户 UI 操作，不是命令运行时间
    const startedAt = Date.now();
    await using output = new BashOutput(request.ctx.sessionManager.getSessionId());
    const { onUpdate } = request;

    // 流式进度：限流推送尾部快照（对齐 pi 内置 bash 的实时输出体验）
    const emitUpdate = throttle(
      () => {
        onUpdate?.({
          content: [{ type: "text", text: output.tailSnapshot() }],
          details: undefined,
        });
      },
      BASH_UPDATE_THROTTLE_MS,
      { trailing: true },
    );

    try {
      onUpdate?.({ content: [], details: undefined });
      const { exitCode } = await runInSandbox(runtime, {
        workspace,
        commandCwd: execCwd,
        command: request.command,
        unsandboxed: local,
        onData: (data) => {
          output.append(data);
          emitUpdate();
        },
        signal: request.signal,
        timeout: request.timeout,
      });
      const partial = await this.finalizeOutput(output);
      return {
        exitCode,
        sandboxHint,
        ...(sandboxReminder && { sandboxReminder }),
        output: partial.output,
        ...(partial.fullOutputPath && { fullOutputPath: partial.fullOutputPath }),
        truncation: partial.truncation,
      };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      // 超时/中断：把命令终止前已捕获的输出附在错误上（文本 + 落盘路径），
      // 展示时输出在前、状态在最后（对齐 pi 内置 bash），避免只报超时丢输出
      // 超时识别：优先 name=TimeoutError（对齐标准错误分类），
      // 兼容 pi local ops 抛的 `timeout:N`（name=Error）
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.message.startsWith("timeout:"))
      ) {
        const partial = await this.finalizeOutput(output);
        throw new BashInterruptedError(
          "timeout",
          `Command timed out after ${error.message.slice("timeout:".length)} seconds`,
          partial,
          sandboxHint,
          elapsedMs,
          error,
          sandboxReminder,
        );
      }
      // 中断识别：优先 name=AbortError（throwIfAborted/signal.reason），
      // 兼容 pi local ops 抛的 new Error("aborted")
      if (error instanceof Error && (error.name === "AbortError" || error.message === "aborted")) {
        const partial = await this.finalizeOutput(output);
        throw new BashInterruptedError(
          "aborted",
          "Command aborted by user",
          partial,
          sandboxHint,
          elapsedMs,
          error,
          sandboxReminder,
        );
      }
      throw error;
    } finally {
      emitUpdate.flush();
      emitUpdate.cancel();
    }
  }

  /** 关闭输出流并返回截断后的快照；未截断时删除临时文件（成功与超时/中断路径共用）。 */
  private async finalizeOutput(output: BashOutput): Promise<BashExecutionPartial> {
    await output.close();
    const truncation = truncateTail(output.tailText());
    // 未截断：完整输出已直接返回给模型，临时文件没有用途，删掉避免
    // agent-dir/tmp 堆积无主文件（删除失败只残留文件，不影响命令结果）
    if (!truncation.truncated && output.filePath) {
      try {
        await unlink(output.filePath);
      } catch {
        // 删除失败（如沙箱只读）：best-effort，命令结果不受影响
      }
      output.filePath = undefined;
    }
    return {
      output: truncation.content,
      ...(output.filePath && { fullOutputPath: output.filePath }),
      // 用精确统计值覆盖尾部缓冲的估算（提示文本的行数/字节数要准确）
      truncation: { ...truncation, ...output.stats },
    };
  }

  private resolve(ctx: Pick<ExtensionContext, "cwd">): ResolvedBwrap {
    const config = loadBwrapConfig(ctx.cwd);
    if (!this.resolved) this.resolved = resolveBwrap(config);
    return this.resolved;
  }

  private async approveFullAccess(
    ctx: ExtensionContext,
    command: string,
    reason: string | undefined,
    execCwd: string,
  ): Promise<FullAccessGrant> {
    // hasUI 判定推迟到审批时刻：无 UI 会话弹不了审批框，按用户点 Deny 的标准文案拒绝
    if (!ctx.hasUI) throw new Error(UNSANDBOXED_DENIED);
    const decision = await this.approveFullAccessUI(ctx, command, reason, execCwd);
    // 关闭对话框 = 中断并拒绝，不循环重问
    if (decision === undefined) {
      ctx.abort();
      throw new Error("User denied the command execution.");
    }
    const { result, foreverApprovedPattern } = decision;
    switch (result) {
      case RUN_IN_SANDBOX: {
        // 用户拒绝提权、改为沙盒内执行：allow 规则意味着自动放行非沙盒执行，
        // 与该选择矛盾，即使在子菜单勾选了 pattern 也不持久化
        return "sandbox";
      }
      case DENY: {
        if (foreverApprovedPattern.length > 0) {
          await this.persistAllowRule(ctx, command, foreverApprovedPattern);
        }
        throw new Error(UNSANDBOXED_DENIED);
      }
      case DENY_WITH_REASON: {
        if (foreverApprovedPattern.length > 0) {
          await this.persistAllowRule(ctx, command, foreverApprovedPattern);
        }
        const feedback = decision.reason?.trim() ?? "";
        throw new Error(
          feedback
            ? `User denied command execution with reason: ${feedback}`
            : "User denied command execution.",
        );
      }
      case ALLOW_ONCE: {
        if (foreverApprovedPattern.length > 0) {
          await this.persistAllowRule(ctx, command, foreverApprovedPattern);
        }
        return "full-access";
      }
      default: {
        // UI 层只会产出上面几种 label；未识别的按历史行为放行，不持久化规则
        return "full-access";
      }
    }
  }

  /**
   * 全权限审批的 UI 层：弹对话框收集用户决策并返回结构化结果，副作用
   * （abort / throw / 持久化规则）由调用方根据结果处理。
   * 返回 undefined 表示对话框被关闭（用户取消）。
   */
  private async approveFullAccessUI(
    ctx: ExtensionContext,
    command: string,
    reason: string | undefined,
    execCwd: string,
  ): Promise<FullAccessUIDecision | undefined> {
    // 弹框前解析命令的持久化规则：`echo 1 | head` → `echo *`、`head *`。
    // 持久化规则的勾选折叠进 EDIT_RULES 子菜单，主决策列表只保留放行/拒绝，
    // 避免一屏 checkbox 淹没决策项。
    const patterns = await commandPatternsFor(command);
    // 子菜单只列出未命中 allow 规则的 pattern：已提前允许的部分自动放行，
    // 无需再展示或重复勾选持久化（deny 命中的命令在 evaluate 阶段已被拒绝）。
    const rules = this.resolve(ctx).approvalRules;
    const unallowedPatterns = [
      ...new Set(
        patterns.filter((pattern) => {
          const rule = rules.findLast((r) => matchRule(pattern, r.pattern));
          return rule?.action !== "allow";
        }),
      ),
    ];
    // dcg 扫描建议是可选的参考文本：未安装时静默跳过；已安装但扫描失败
    // 时 notify 提示，弹窗本身与无 dcg 时一致
    const outcome = await dcgSuggestion(command);
    if (outcome.kind === "failed") {
      ctx.ui.notify(`dcg 扫描失败，本次无破坏性命令建议: ${outcome.detail}`, "warning");
    }
    // 弹框主体按行组织（'\n' join），便于 review；suggestion 块带前导空行 +
    // 尾部 "---" 分隔。
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
    lines.push(fenceCodeBlock(command));
    // 执行目录与工作区不同时，提示实际执行目录（execCwd 是解析后的绝对路径，
    // 显示用 pretty path 风格：home 内 `~/…`，否则绝对路径）
    if (execCwd !== ctx.cwd) {
      lines.push(`Workdir: ${escapeHtml(formatDisplayPath(ctx.cwd, execCwd))}`);
    }
    const description = lines.join("\n");

    // 主决策列表：允许一次 / 拒绝 / 拒绝并附理由。有可持久化的 pattern 时
    // 追加折叠入口，进入子菜单逐项勾选。
    const actions: SelectAction[] = [
      { label: ALLOW_ONCE },
      { label: RUN_IN_SANDBOX },
      { label: DENY },
      { label: DENY_WITH_REASON, inputPrompt: "Why was this denied?" },
    ];
    if (unallowedPatterns.length > 0) {
      actions.push({ label: EDIT_RULES });
    }
    // 子菜单沿用同一份说明，并补上勾选规则的语义提示。
    const editDescription = [
      "勾选要持久化为允许规则的命令模式（后续同模式命令自动放行，未勾选仅本次处理）:",
      "---",
      "",
      description,
    ].join("\n");

    // 两层循环：子菜单勾选后回到主决策，直到用户在 Allow once / Run this in sandbox /
    // Deny 系列中做出选择。勾选的规则在放行时持久化；Deny 系列同样持久化（用户确认
    // 该模式可信，只是本次命令不执行）；Run this in sandbox 不持久化。
    // 子菜单关闭 = 返回主决策；主决策关闭 = 取消（上层按拒绝处理）。
    let selected: string[] = [];
    for (;;) {
      const pending =
        selected.length > 0
          ? `\n\n将持久化为允许规则: ${selected.map((pattern) => escapeHtml(pattern)).join(", ")}`
          : "";
      const verdict = await selectWithOptionalInput(description + pending, actions, ctx.ui, {
        signal: ctx.signal,
      });
      if (verdict === undefined) return undefined;
      if (verdict.label !== EDIT_RULES) {
        return {
          result: verdict.label,
          foreverApprovedPattern: selected,
          reason: verdict.input,
        };
      }
      selected = await selectMultiple(
        editDescription,
        unallowedPatterns.map((pattern) => ({ label: pattern })),
        ctx.ui,
        { signal: ctx.signal, doneLabel: BACK },
      );
    }
  }

  /** 把命令的权限模式写入项目 bwrap.json 的 approvalRules（allow forever）。 */
  private async persistAllowRule(
    ctx: ExtensionContext,
    command: string,
    patterns?: string[],
  ): Promise<void> {
    const rulePatterns = patterns ?? (await commandPatternsFor(command));
    if (rulePatterns.length === 0) return; // 解析失败：本次处理，不写规则
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
      "bwrap-net-allowlist": {
        name: "bwrap-net-allowlist",
        usage: "",
        description: "Sandbox on, network filtered by allowlist, workspace writable",
        flags: Type.Object({}),
      },
      "bwrap-readonly": {
        name: "bwrap-readonly",
        usage: "",
        description: "Sandbox on, network off, no writes",
        flags: Type.Object({}),
      },
      "bwrap-reload": {
        name: "bwrap-reload",
        usage: "",
        description: "Reload bwrap config and restart the network stack",
        flags: Type.Object({}),
      },
      "bwrap-deny-request": {
        name: "bwrap-deny-request",
        usage: "",
        description: "Deny unsandboxed execution requests without approval",
        flags: Type.Object({}),
      },
      "bwrap-allow-request": {
        name: "bwrap-allow-request",
        usage: "",
        description: "Require user approval for unsandboxed execution requests again",
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
          const deny = runtime.denyPaths.map((path) => resolveBwrapPath(path, commandCtx.cwd));
          commandCtx.ui.notify(
            `bwrap ${runtime.mode} ${runtime.network ? "net" : "no-net"} write:[${writable.join(", ")}] deny:[${deny.join(", ") || "-"}]`,
            "info",
          );
        }),
    });

    for (const [name, mode] of [
      ["bwrap-allow-all", "allow-all"],
      ["bwrap-workspace-write", "workspace-write"],
      ["bwrap-allow-net", "allow-net"],
      ["bwrap-net-allowlist", "net-allowlist"],
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

    pi.registerCommand("bwrap-reload", {
      description: specs["bwrap-reload"].description,
      handler: (args, ctx) =>
        this.runCommand(pi, specs["bwrap-reload"], args, ctx, (commandCtx) => {
          this.reload(commandCtx);
        }),
    });

    for (const [name, deny] of [
      ["bwrap-deny-request", true],
      ["bwrap-allow-request", false],
    ] as const) {
      pi.registerCommand(name, {
        description: specs[name].description,
        handler: (args, ctx) =>
          this.runCommand(pi, specs[name], args, ctx, (commandCtx) =>
            this.setDenyRequests(deny, commandCtx),
          ),
      });
    }
  }

  private reload(ctx: ExtensionCommandContext): void {
    this.resolved = undefined;
    this.bwrapUnavailable = false;
    const runtime = this.resolve(ctx);
    ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", this.statusLabel(runtime.mode)));
    ctx.ui.notify(`bwrap config reloaded (mode: ${runtime.mode})`, "info");
  }

  private switchMode(pi: ExtensionAPI, mode: BwrapMode, ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) {
      ctx.ui.notify("bwrap mode cannot be changed without an interactive UI", "warning");
      return;
    }
    this.setMode(ctx.cwd, mode);
    ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", this.statusLabel(mode)));
    notifyMode(ctx, mode);
    pi.sendMessage({
      customType: "info",
      content: `Bwrap sandbox mode changed to "${mode}".`,
      display: true,
    });
  }

  /** 状态行文案：模式 + 非沙盒请求策略（拒绝时标注，便于解释模型的请求为何被拒）。 */
  private statusLabel(mode: BwrapMode): string {
    return `bwrap: ${mode}${this.policy.deniesRequests() ? " (requests denied)" : ""}`;
  }

  /**
   * 切换非沙盒请求策略：拒绝时模型的提权请求（bash 的 `dangerouslyDisableSandbox`、
   * 编辑类工具的工作区外写入）直接按用户拒绝处理，不再弹审批框。
   */
  private setDenyRequests(deny: boolean, ctx: ExtensionCommandContext): void {
    this.policy.setDenyRequests(deny);
    ctx.ui.notify(
      deny
        ? "Non-sandbox requests are denied without approval; /bwrap-allow-request restores approval."
        : "Non-sandbox requests require user approval again.",
      "info",
    );
    const runtime = this.resolve(ctx);
    if (ctx.hasUI && runtime.bwrapEnabled && !this.bwrapUnavailable) {
      ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", this.statusLabel(runtime.mode)));
    }
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

/** 缺省自建一份不跨入口同步的策略；入口通常显式传入 `createRequestPolicy(pi.events)`。 */
export function createBwrapRuntime(policy: RequestPolicy = createRequestPolicy()): BwrapRuntime {
  return new BwrapRuntime(policy);
}
