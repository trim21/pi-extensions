/**
 * bwrap Sandbox Extension
 *
 * Wraps all bash commands in bubblewrap (bwrap) for OS-level sandboxing.
 * No external dependencies — uses only Node.js built-ins.
 *
 * System requirements: bwrap (bubblewrap) must be installed.
 *   - Debian/Ubuntu: apt install bubblewrap
 *   - Arch: pacman -S bubblewrap
 *   - Fedora: dnf install bubblewrap
 *
 * ## Modes
 *
 * Three modes, switchable at runtime:
 *
 *   allow-all       No sandbox. Network allowed. All commands run natively.
 *   workspace-write Sandbox enabled, network blocked. Project dir + /tmp writable.
 *                   Model can request full access via bash tool parameter.
 *   readonly        Sandbox enabled, network blocked, no writable paths.
 *
 * ## Escalation
 *
 * The bash tool is re-registered with `request_full_access` and
 * `request_full_access_reason` parameters. When full access is needed,
 * the model must explain why (e.g., network required, writing outside workspace).
 *
 * Models should try sandbox mode first when unsure. If the command fails due to
 * sandbox restrictions, retry with full access and provide the failure reason.
 *
 * Config files (merged, project takes precedence):
 *   - ~/.pi/agent/extensions/bwrap.json (global)
 *   - .pi/bwrap.json (project-local)
 *
 * Example .pi/bwrap.json:
 * ```json
 * {
 *   "mode": "workspace-write",
 *   "writablePaths": [".", "/tmp"],
 *   "tmpfsPaths": [],
 *   "extraArgs": []
 * }
 * ```
 *
 * Commands:
 *   /bwrap              Show current mode and paths
 *   /bwrap-allow-all    Full access, sandbox off
 *   /bwrap-workspace-write  Sandbox on, workspace writable
 *   /bwrap-readonly     Sandbox on, no writes
 *
 * Usage:
 *   pi -e ./bwrap
 *   pi -e ./bwrap --no-bwrap
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashOperations, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";

const SANDBOX_PROMPT = `
## Command Execution
You are running inside a sandbox.

Three sandbox modes exist:
- allow-all: sandbox off, network on, full access
- readonly: sandbox on, network off, nothing writable
- workspace-write: sandbox on, network off, only workspace and /tmp writable

In workspace-write and readonly modes, the bash tool has a
\`request_full_access\` boolean parameter.
Set it to true to request execution outside the sandbox.
The user must approve.

When requesting full access, you MUST also provide
a \`request_full_access_reason\` string explaining why:
  - What specific operation requires escaping the sandbox
  - e.g. "needs network to install npm packages",
    "needs to write to /etc/hosts which is outside the workspace"

In addition to root files system, .git, .pi, and .agent directories inside workspace
are still read-only even in workspace-write mode.
Git operations that change git status (add, commit, push, etc.)
require request_full_access: true.

the \`request_full_access\` is only needed for:
  - Writing to paths outside the configured writable directories,
  - Operations requiring network access (curl, npm install, git push, etc.).
Writing inside the workspace or /tmp, or reading any file, does not require escalation,
for example, the simple \`ls\`, \`cat\`, \`find\` or \`grep\` and git command that only read from .git directory but not change .git directory and other read only commands.
**If the command is readonly operator, do not use \`request_full_access\`**

**Strategy for uncertain cases**: if you are not sure whether a command will
work inside the sandbox, run it WITHOUT full access first. If it fails with
"Read-only file system", "Permission denied", "Network is unreachable", or
"Could not resolve host", then retry with \`request_full_access: true\`
and set \`request_full_access_reason\` to describe the failure.
`;

const PROTECTED_DIRS = [".git", ".pi", ".agent"];

let bwrapPath = "";

function findBwrap(override?: string): string {
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(`bwrap not found at configured path: ${override}`);
  }

  if (bwrapPath) return bwrapPath;

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    const p = join(dir, "bwrap");
    if (existsSync(p)) {
      bwrapPath = p;
      return p;
    }
  }

  const candidates = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/run/current-system/sw/bin/bwrap"];
  for (const p of candidates) {
    if (existsSync(p)) {
      bwrapPath = p;
      return p;
    }
  }

  throw new Error(
    "bwrap (bubblewrap) not found in PATH. Install it:\n" +
      "  apt install bubblewrap (Debian/Ubuntu)\n" +
      "  pacman -S bubblewrap (Arch)\n" +
      "  dnf install bubblewrap (Fedora)",
  );
}

type BwrapMode = "allow-all" | "workspace-write" | "readonly";

interface BwrapConfig {
  mode: BwrapMode;
  bwrapPath?: string;
  writablePaths?: string[];
  extraWritablePaths: string[];
  tmpfsPaths?: string[];
  extraArgs?: string[];
}

interface ResolvedBwrap {
  mode: BwrapMode;
  bwrapEnabled: boolean;
  network: boolean;
  bwrapPath?: string;
  writablePaths: string[];
  extraWritablePaths: string[];
  tmpfsPaths: string[];
  extraArgs: string[];
}

function resolveBwrap(config: BwrapConfig): ResolvedBwrap {
  const base = {
    mode: config.mode,
    bwrapPath: config.bwrapPath,
    writablePaths: config.writablePaths ?? ([".", "/tmp"] as string[]),
    extraWritablePaths: config.extraWritablePaths,
    tmpfsPaths: config.tmpfsPaths ?? ([] as string[]),
    extraArgs: config.extraArgs ?? ([] as string[]),
  };
  switch (config.mode) {
    case "allow-all":
      return { ...base, bwrapEnabled: false, network: true };
    case "workspace-write":
      return { ...base, bwrapEnabled: true, network: false };
    case "readonly":
      return { ...base, bwrapEnabled: true, network: false, writablePaths: [] };
  }
}

const DEFAULT_CONFIG: BwrapConfig = {
  mode: "workspace-write",
  writablePaths: [".", "/tmp"],
  extraWritablePaths: [],
  tmpfsPaths: [],
  extraArgs: [],
};

function deepMerge(base: BwrapConfig, overrides: Partial<BwrapConfig>): BwrapConfig {
  return {
    mode: overrides.mode ?? base.mode,
    bwrapPath: overrides.bwrapPath ?? base.bwrapPath,
    writablePaths: overrides.writablePaths ?? base.writablePaths,
    extraWritablePaths: [...base.extraWritablePaths, ...(overrides.extraWritablePaths ?? [])],
    tmpfsPaths: overrides.tmpfsPaths ?? base.tmpfsPaths,
    extraArgs: overrides.extraArgs ?? base.extraArgs,
  };
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME!;
    return join(home, p.slice(2));
  }
  return p;
}

function resolvePath(p: string, cwd: string): string {
  const expanded = expandPath(p);
  if (expanded === ".") return cwd;
  return expanded;
}

function loadConfig(cwd: string): BwrapConfig {
  const globalConfigPath = join(getAgentDir(), "extensions", "bwrap.json");
  const projectConfigPath = join(cwd, ".pi", "bwrap.json");

  const globalConfig: Partial<BwrapConfig> = {};
  const projectConfig: Partial<BwrapConfig> = {};

  for (const [path, target] of [
    [globalConfigPath, globalConfig],
    [projectConfigPath, projectConfig],
  ] as const) {
    if (existsSync(path)) {
      try {
        Object.assign(target, JSON.parse(readFileSync(path, "utf-8")));
      } catch (e) {
        console.error(`Warning: Could not parse ${path}: ${e}`);
      }
    }
  }

  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function buildBwrapArgs(resolved: ResolvedBwrap, cwd: string): string[] {
  // Process-isolation flags placed before filesystem mounts.
  //   --new-session     Escape the parent TTY (no Ctrl-C leakage)
  //   --die-with-parent Auto-SIGTERM child when the bwrap parent exits
  //   --unshare-user    User namespace (root-inside-ns ≠ host root)
  //   --unshare-pid     PID namespace (kill(-1) confined to sandbox)
  const args: string[] = ["--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid"];

  for (const path of resolved.writablePaths) {
    const r = resolvePath(path, cwd);
    args.push("--bind", r, r);
  }
  for (const path of resolved.extraWritablePaths) {
    const r = resolvePath(path, cwd);
    args.push("--bind", r, r);
  }
  for (const path of resolved.tmpfsPaths) {
    const r = resolvePath(path, cwd);
    args.push("--tmpfs", r);
  }

  if (!resolved.network) {
    args.push("--unshare-net");
  }

  // Ro-bind protected dirs inside the workspace to override writable parent mounts
  for (const name of PROTECTED_DIRS) {
    const abs = join(cwd, name);
    if (existsSync(abs)) {
      args.push("--ro-bind", abs, abs);
    }
  }

  args.push(...resolved.extraArgs);
  return args;
}

// ── Lazy seccomp filter cache ────────────────────────────────────────
// BPF bytecode is deterministic per architecture — shipped as static
// .bpf files alongside the extension (src/bwrap/seccomp-<arch>.bpf).
// At runtime we pick the right file and open it per-exec.

const SECCOMP_BPF_FILE: string = (() => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  if (process.arch === "x64") return join(dir, "seccomp-x86_64.bpf");
  if (process.arch === "arm64") return join(dir, "seccomp-aarch64.bpf");
  return "";
})();

function getSeccompFd(): number | undefined {
  if (!SECCOMP_BPF_FILE) return undefined;
  try {
    return openSync(SECCOMP_BPF_FILE, "r");
  } catch {
    return undefined;
  }
}

function createBwrapBashOps(resolved: ResolvedBwrap): BashOperations {
  return {
    async exec(command, cwd: string, { onData, signal, timeout }) {
      const bwrapArgs = buildBwrapArgs(resolved, cwd);
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      if (signal?.aborted) {
        throw new Error("aborted");
      }

      // ── seccomp: block AF_UNIX + network syscalls ───────────────
      // bwrap --unshare-net handles IP; seccomp closes the UNIX socket
      // gap (Docker CLI, mysqld, etc.). Filter is generated once.
      const seccompFd = !resolved.network ? getSeccompFd() : undefined;

      const baseArgs: string[] = [
        "--ro-bind",
        "/",
        "/",
        ...bwrapArgs,
        "--dev",
        "/dev",
        "--proc",
        "/proc",
      ];

      // Two spawn paths so TypeScript can infer the correct child type.
      const child: ChildProcess =
        seccompFd !== undefined
          ? spawn(
              findBwrap(resolved.bwrapPath),
              [...baseArgs, "--seccomp", "3", "--", "bash", "-c", command],
              {
                cwd,
                detached: true,
                stdio: ["ignore", "pipe", "pipe", seccompFd],
                env: process.env,
              },
            )
          : spawn(findBwrap(resolved.bwrapPath), [...baseArgs, "--", "bash", "-c", command], {
              cwd,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: process.env,
            });

      return new Promise((resolve, reject) => {
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        // ── Signal forwarding ──────────────────────────────────────
        // With --new-session + detached, terminal signals (Ctrl-C) only
        // reach the parent. Forward SIGHUP/SIGINT/SIGTERM to the bwrap
        // child so the sandboxed command can react before the parent
        // (potentially) exits. --die-with-parent already covers the
        // case where the parent actually dies.
        const forwardedSignals: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];
        const signalForwarders: Array<() => void> = [];

        for (const sig of forwardedSignals) {
          const handler = () => {
            if (child.pid) {
              try {
                process.kill(-child.pid, sig);
              } catch {
                child.kill(sig);
              }
            }
            // Remove ourselves and re-raise so the default handler runs.
            process.removeListener(sig, handler);
            process.kill(process.pid, sig);
          };
          process.on(sig, handler);
          signalForwarders.push(() => process.removeListener(sig, handler));
        }

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          // Remove signal forwarders now that the child is gone.
          for (const unforward of signalForwarders) {
            unforward();
          }

          // Close the per-exec seccomp fd (temp file is reused).
          if (seccompFd !== undefined) {
            try {
              closeSync(seccompFd);
            } catch {
              /* ignore */
            }
          }

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Count the longest consecutive backtick run in a string.
 */
function maxConsecutiveBackticks(text: string): number {
  let maxCount = 0;
  let currentCount = 0;
  for (const ch of text) {
    if (ch === "`") {
      currentCount++;
      if (currentCount > maxCount) maxCount = currentCount;
    } else {
      currentCount = 0;
    }
  }
  return maxCount;
}

/**
 * Wrap code in fenced code blocks (```) for literal plain-text rendering.
 * Uses N+1 backticks for the fence where N is the longest consecutive
 * backtick sequence in the code, so no escaping is needed.
 */
function fenceCodeBlock(code: string): string {
  const fenceLen = Math.max(3, maxConsecutiveBackticks(code) + 1);
  const fence = "`".repeat(fenceLen);
  return `${fence}\n${code}\n${fence}`;
}

function notifyMode(
  ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } },
  mode: BwrapMode,
) {
  const labels: Record<BwrapMode, string> = {
    "allow-all": "allow-all: sandbox off, network on",
    "workspace-write": "workspace-write: sandbox on, network off",
    readonly: "readonly: sandbox on, network off, read-only fs",
  };
  ctx.ui.notify(labels[mode], "info");
}

const sandboxedBashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, no default timeout)",
    }),
  ),
  request_full_access: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to run the command without sandbox, the command will get full fs write permission and network access. The user will review this command and user must approve this. Do not set this if your command doesn't write any file and doesn't need network access.",
    }),
  ),
  request_full_access_reason: Type.Optional(
    Type.String({
      description:
        "Required when request_full_access is true. Explain why the command needs full access outside the sandbox (e.g. 'needs network for npm install', 'must write to /etc/config outside workspace').",
    }),
  ),
});

interface SandboxedBashInput {
  command: string;
  timeout?: number;
  request_full_access?: boolean;
  request_full_access_reason?: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-bwrap", {
    description: "Disable bwrap sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);

  let resolved: ResolvedBwrap | null = null;
  let manuallyDisabled = false;

  function getResolved(): ResolvedBwrap {
    if (!resolved) {
      resolved = resolveBwrap(loadConfig(localCwd));
    }
    return resolved;
  }

  function isEnabled() {
    return !manuallyDisabled && getResolved().bwrapEnabled;
  }

  function setMode(mode: BwrapMode) {
    const config = loadConfig(localCwd);
    config.mode = mode;
    resolved = resolveBwrap(config);
  }

  pi.registerTool({
    name: localBash.name,
    label: "bash (bwrap)",
    description:
      localBash.description +
      "\n\nSet request_full_access to true to request unsandboxed execution.",
    parameters: sandboxedBashSchema,
    prepareArguments: (args) => {
      return Value.Parse(sandboxedBashSchema, args);
    },
    executionMode: localBash.executionMode,
    async execute(id, params, signal, onUpdate, ctx) {
      const r = getResolved();

      if (!r.bwrapEnabled) {
        return localBash.execute(id, params, signal, onUpdate);
      }

      const escalate = params.request_full_access === true;

      if (escalate) {
        if (ctx?.hasUI) {
          const reason = params.request_full_access_reason;
          const reasonText = reason
            ? `\n\nReason: ${escapeHtml(reason)}`
            : "\n\n(No reason provided by model)";
          const codeBlock = fenceCodeBlock(params.command);
          const desc = `Allow this command to run without sandbox?\n---\n${reasonText}\n---\n${codeBlock}`;

          let choice: string | undefined;
          while (!choice) {
            choice = await ctx.ui.select(desc, ["Approve once", "Block", "Block with reason"]);
            if (typeof choice === "undefined") {
              ctx.abort();
              throw new Error("User denied the command execution.");
            }
            if (choice === "Block with reason") {
              const feedback = await ctx.ui.input("Why was this denied?");
              if (feedback === undefined) {
                choice = undefined; // cancelled input, retry select
                continue;
              }
              throw new Error(
                feedback
                  ? `User denied unsandboxed execution: ${feedback}`
                  : "User denied unsandboxed execution.",
              );
            }
          }
          if (choice !== "Approve once") {
            throw new Error("User denied unsandboxed execution.");
          }
        }
        return localBash.execute(id, params, signal, onUpdate);
      }

      const sandboxedBash = createBashTool(localCwd, {
        operations: createBwrapBashOps(r),
      });
      return sandboxedBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const noBwrap = pi.getFlag("no-bwrap") as boolean;

    if (noBwrap) {
      manuallyDisabled = true;
      resolved = null;
      ctx.ui.notify("bwrap sandbox disabled via --no-bwrap", "warning");
      return;
    }

    if (!process.env.HOME) {
      manuallyDisabled = true;
      ctx.ui.notify("bwrap requires HOME environment variable", "error");
      return;
    }

    if (process.platform !== "linux") {
      manuallyDisabled = true;
      ctx.ui.notify("bwrap sandbox requires Linux", "warning");
      return;
    }

    const config = loadConfig(ctx.cwd);
    resolved = resolveBwrap(config);

    if (resolved.bwrapEnabled) {
      try {
        findBwrap(resolved.bwrapPath);
      } catch (err) {
        resolved = null;
        manuallyDisabled = true;
        ctx.ui.notify(err instanceof Error ? err.message : "bwrap not found", "error");
        return;
      }
    }

    const r = resolved;

    if (!r.bwrapEnabled) {
      ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${r.mode}`));
      ctx.ui.notify(`bwrap mode: ${r.mode}`, "info");
      return;
    }

    ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${r.mode}`));
    ctx.ui.notify(`bwrap initialized (${r.mode})`, "info");
  });

  pi.on("session_shutdown", () => {
    resolved = null;
    manuallyDisabled = false;
  });

  pi.on("before_agent_start", (event) => {
    const r = getResolved();

    return {
      systemPrompt:
        event.systemPrompt + "\n\n" + SANDBOX_PROMPT + `\n\nCurrent mode: **${r.mode}**\n`,
    };
  });

  pi.registerCommand("bwrap", {
    description: "Show bwrap sandbox configuration",
    handler: async (_args, ctx) => {
      const r = getResolved();
      if (!r.bwrapEnabled) {
        ctx.ui.notify(`bwrap disabled (mode: ${r.mode})`, "info");
        return;
      }

      const net = r.network ? "net" : "no-net";
      const w = r.writablePaths.map((p) => resolvePath(p, localCwd));
      const t = r.tmpfsPaths.map((p) => resolvePath(p, localCwd));

      ctx.ui.notify(
        `bwrap ${r.mode} ${net} write:[${w.join(", ")}] tmpfs:[${t.join(", ") || "-"}]`,
        "info",
      );
    },
  });

  function switchMode(
    mode: BwrapMode,
    ctx: {
      ui: {
        notify: (m: string, t?: "info" | "warning" | "error") => void;
        theme: any;
        setStatus: (k: string, t: string | undefined) => void;
      };
    },
  ) {
    setMode(mode);
    const r = getResolved();

    if (!r.bwrapEnabled) {
      ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${mode}`));
    } else {
      ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${mode}`));
    }

    notifyMode(ctx, mode);
    pi.sendMessage({
      customType: "info",
      content: `Bwrap sandbox mode changed to "${mode}".`,
      display: true,
    });
  }

  pi.registerCommand("bwrap-allow-all", {
    description: "Disable bwrap sandbox, full access",
    handler: async (_args, ctx) => switchMode("allow-all", ctx),
  });

  pi.registerCommand("bwrap-workspace-write", {
    description: "Sandbox on, network off, workspace writable",
    handler: async (_args, ctx) => switchMode("workspace-write", ctx),
  });

  pi.registerCommand("bwrap-readonly", {
    description: "Sandbox on, network off, no writes",
    handler: async (_args, ctx) => switchMode("readonly", ctx),
  });
}
