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
 * The bash tool is re-registered with a `dangerously_allow_full_access` parameter.
 * When set to true, the user is prompted to approve unsandboxed execution.
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
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createLocalBashOperations,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const ESCALATE_PREFIX = "ESCALATE:";

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
  writablePaths: string[];
  extraReadablePaths: string[];
  tmpfsPaths: string[];
  extraArgs: string[];
}

interface ResolvedBwrap {
  mode: BwrapMode;
  bwrapEnabled: boolean;
  network: boolean;
  bwrapPath?: string;
  writablePaths: string[];
  extraReadablePaths: string[];
  tmpfsPaths: string[];
  extraArgs: string[];
}

function resolveBwrap(config: BwrapConfig): ResolvedBwrap {
  const base = {
    mode: config.mode,
    bwrapPath: config.bwrapPath,
    writablePaths: config.writablePaths,
    extraReadablePaths: config.extraReadablePaths,
    tmpfsPaths: config.tmpfsPaths,
    extraArgs: config.extraArgs,
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
  extraReadablePaths: [],
  tmpfsPaths: [],
  extraArgs: [],
};

function deepMerge(base: BwrapConfig, overrides: Partial<BwrapConfig>): BwrapConfig {
  return {
    mode: overrides.mode ?? base.mode,
    bwrapPath: overrides.bwrapPath ?? base.bwrapPath,
    writablePaths: overrides.writablePaths ?? base.writablePaths,
    extraReadablePaths: [...base.extraReadablePaths, ...(overrides.extraReadablePaths ?? [])],
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
  const args: string[] = [];

  for (const path of resolved.writablePaths) {
    const r = resolvePath(path, cwd);
    args.push("--bind", r, r);
  }
  for (const path of resolved.extraReadablePaths) {
    const r = resolvePath(path, cwd);
    args.push("--ro-bind", r, r);
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

function createBwrapBashOps(resolved: ResolvedBwrap, cwd: string): BashOperations {
  const bwrapArgs = buildBwrapArgs(resolved, cwd);

  return {
    async exec(command, cwd: string, { onData, signal, timeout }) {
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      if (signal?.aborted) {
        throw new Error("aborted");
      }

      const child = spawn(
        findBwrap(resolved.bwrapPath),
        [
          ...bwrapArgs,
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--",
          "bash",
          "-c",
          command,
        ],
        {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

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

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

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

function createEscalateAwareBashOps(resolved: ResolvedBwrap, cwd: string): BashOperations {
  const bwrapOps = createBwrapBashOps(resolved, cwd);
  const localOps = createLocalBashOperations();

  return {
    async exec(command, cwd, opts) {
      if (command.startsWith(ESCALATE_PREFIX)) {
        const actual = command.slice(ESCALATE_PREFIX.length).trim();
        return localOps.exec(actual, cwd, opts);
      }
      return bwrapOps.exec(command, cwd, opts);
    },
  };
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
  dangerously_allow_full_access: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to request unsandboxed execution. User must approve. " +
        "Ignored in readonly mode (always blocked).",
    }),
  ),
});

interface SandboxedBashInput {
  command: string;
  timeout?: number;
  dangerously_allow_full_access?: boolean;
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
      "\n\nSet dangerously_allow_full_access to true to request unsandboxed execution.",
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

      const escalate = params.dangerously_allow_full_access === true;

      if (escalate) {
        if (ctx?.hasUI) {
          let choice: string | undefined;
          while (!choice) {
            choice = await ctx.ui.select(
              `Unsandboxed execution requested:\n\n\`\`\`\n${params.command}\n\`\`\`\n\nAllow this command to run without sandbox?`,
              ["Approve once", "Block", "Block with reason"],
            );
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
        operations: createBwrapBashOps(r, localCwd),
      });
      return sandboxedBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", () => {
    const r = getResolved();
    if (!r.bwrapEnabled) return;
    return { operations: createEscalateAwareBashOps(r, localCwd) };
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
    const net = r.network ? "net" : "no-net";
    const w = r.writablePaths.length;

    if (!r.bwrapEnabled) {
      ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${r.mode}`));
      ctx.ui.notify(`bwrap mode: ${r.mode}`, "info");
      return;
    }

    ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${r.mode} ${net} ${w}w`));
    ctx.ui.notify(`bwrap initialized (${r.mode})`, "info");
  });

  pi.on("session_shutdown", () => {
    resolved = null;
    manuallyDisabled = false;
    promptInjected = false;
  });

  let promptInjected = false;

  pi.on("before_agent_start", (_event) => {
    if (promptInjected) return;
    promptInjected = true;
    if (!getResolved().bwrapEnabled) return;

    return {
      systemPrompt:
        _event.systemPrompt +
        [
          "",
          "You are running inside a bwrap sandbox. The root filesystem is read-only.",
          "",
          "Three sandbox modes exist:",
          "  allow-all       — sandbox off, network on, full filesystem access",
          "  workspace-write — sandbox on, network off, workspace and /tmp writable",
          "  readonly        — sandbox on, network off, nothing writable",
          "",
          "In workspace-write and readonly modes, the bash tool has a",
          "dangerously_allow_full_access boolean parameter. Set it to true",
          "to request execution outside the sandbox. The user must approve.",
          "",
          'If you encounter "Read-only file system" or "Permission denied" in',
          "a bash command, retry with dangerously_allow_full_access: true.",
          "",
        ].join("\n"),
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
      const net = r.network ? "net" : "no-net";
      const w = r.writablePaths.length;
      ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${mode} ${net} ${w}w`));
    }

    notifyMode(ctx, mode);
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
