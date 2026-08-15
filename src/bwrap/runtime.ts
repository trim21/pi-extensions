import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";

import { type CommandSpec, parseCommand } from "../lib/cli.js";
import { selectWithOptionalInput } from "../lib/ui.js";
import {
  type BwrapMode,
  createBwrapBashOperations,
  findBwrap,
  loadBwrapConfig,
  resolveBwrap,
  resolveBwrapPath,
  type ResolvedBwrap,
  resolveHeadlessBwrap,
} from "./core.js";

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

export interface BwrapExecutionRequest {
  toolCallId: string;
  command: string;
  timeout?: number;
  requestFullAccess?: boolean;
  requestFullAccessReason?: string;
  signal?: AbortSignal;
  onUpdate?: Parameters<ReturnType<typeof createBashTool>["execute"]>[3];
  ctx: ExtensionContext;
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
      const modeText = ctx.hasUI
        ? `Current bwrap mode: **${runtime.mode}**. The bwrap runtime selects sandboxing and, when requested, user approval for unsandboxed execution.`
        : "This headless session is forced into bwrap readonly mode. Unsandboxed execution cannot be approved.";
      const unavailableText = this.bwrapUnavailable
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

  async execute(request: BwrapExecutionRequest) {
    const runtime = this.resolve(request.ctx);
    if (this.bwrapUnavailable && runtime.bwrapEnabled && request.requestFullAccess !== true) {
      throw new Error(
        "bwrap (bubblewrap) not found; refusing to execute commands without sandboxing. " +
          "Install bubblewrap and restart the session, or pass --no-bwrap to disable the sandbox explicitly.",
      );
    }
    if (request.requestFullAccess === true && runtime.bwrapEnabled) {
      await this.approveFullAccess(request.ctx, request.command, request.requestFullAccessReason);
    }
    const bash =
      runtime.bwrapEnabled && request.requestFullAccess !== true
        ? createBashTool(request.ctx.cwd, { operations: createBwrapBashOperations(runtime) })
        : createBashTool(request.ctx.cwd);
    return bash.execute(
      request.toolCallId,
      { command: request.command, timeout: request.timeout },
      request.signal,
      request.onUpdate,
    );
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
  ): Promise<void> {
    const policy = resolveEscalation({ hasUI: ctx.hasUI });
    if (policy.kind === "deny") throw new Error(policy.reason);
    const description = `Allow this command to run without sandbox?\n---\n\nReason: ${escapeHtml(reason ?? "(No reason provided by model)")}\n---\n${fenceCodeBlock(command)}`;
    while (true) {
      const result = await selectWithOptionalInput(
        description,
        [
          { label: "Approve once" },
          { label: "Block" },
          { label: "Block with reason", inputPrompt: "Why was this denied?" },
        ],
        ctx.ui,
        { signal: ctx.signal },
      );
      if (result === undefined) {
        ctx.abort();
        throw new Error("User denied the command execution.");
      }
      if (result.label === "Approve once") return;
      if (result.label === "Block") throw new Error("User denied unsandboxed execution.");
      // "Block with reason"：取消输入则重新询问；空输入同样拒绝（不带反馈文本）
      if (result.input === undefined) continue;
      throw new Error(
        result.input
          ? `User denied unsandboxed execution: ${result.input}`
          : "User denied unsandboxed execution.",
      );
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
