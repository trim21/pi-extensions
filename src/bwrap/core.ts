import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import { type BashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { expandHome } from "../lib/path.js";
import { type ApprovalRule } from "./approval-rules.js";

const PROTECTED_DIRS = [".git", ".pi", ".agent"];

export const BWRAP_MODES = ["allow-all", "workspace-write", "allow-net", "readonly"] as const;

export type BwrapMode = (typeof BWRAP_MODES)[number];

const bwrapConfigProperties = {
  mode: StringEnum(BWRAP_MODES),
  bwrapPath: Type.Optional(Type.String()),
  writablePaths: Type.Array(Type.String()),
  extraWritablePaths: Type.Array(Type.String()),
  tmpfsPaths: Type.Array(Type.String()),
  extraArgs: Type.Array(Type.String()),
  approvalRules: Type.Optional(
    Type.Array(
      Type.Object(
        {
          action: StringEnum(["allow", "deny"] as const),
          pattern: Type.String({ description: '命令模式，如 "git push *"、"npm install *"' }),
        },
        { additionalProperties: false },
      ),
    ),
  ),
};

export const bwrapConfigSchema = Type.Object(bwrapConfigProperties, {
  additionalProperties: false,
});

export const bwrapConfigFileSchema = Type.Partial(bwrapConfigSchema, {
  additionalProperties: false,
});

export type BwrapConfig = Static<typeof bwrapConfigSchema>;
export type BwrapConfigFile = Static<typeof bwrapConfigFileSchema>;

export interface ResolvedBwrap {
  mode: BwrapMode;
  bwrapEnabled: boolean;
  network: boolean;
  bwrapPath?: string;
  writablePaths: string[];
  extraWritablePaths: string[];
  tmpfsPaths: string[];
  extraArgs: string[];
  /** 全权限执行的自动审批规则（allow/deny 命令模式）。 */
  approvalRules: ApprovalRule[];
}

const DEFAULT_CONFIG: BwrapConfig = {
  mode: "workspace-write",
  writablePaths: [".", "/tmp"],
  extraWritablePaths: [],
  tmpfsPaths: [],
  extraArgs: [],
};

export function resolveBwrap(config: BwrapConfig): ResolvedBwrap {
  const base = {
    mode: config.mode,
    bwrapPath: config.bwrapPath,
    writablePaths: config.writablePaths ?? [".", "/tmp"],
    extraWritablePaths: config.extraWritablePaths,
    tmpfsPaths: config.tmpfsPaths ?? [],
    extraArgs: config.extraArgs ?? [],
    approvalRules: config.approvalRules ?? [],
  };
  switch (config.mode) {
    case "allow-all": {
      return { ...base, bwrapEnabled: false, network: true };
    }
    case "workspace-write": {
      return { ...base, bwrapEnabled: true, network: false };
    }
    case "allow-net": {
      return { ...base, bwrapEnabled: true, network: true };
    }
    case "readonly": {
      return { ...base, bwrapEnabled: true, network: false, writablePaths: [] };
    }
  }
}

export function resolveHeadlessBwrap(config: BwrapConfig): ResolvedBwrap {
  return resolveBwrap({
    ...config,
    mode: "readonly",
    writablePaths: [],
    extraWritablePaths: [],
    tmpfsPaths: [],
    extraArgs: [],
  });
}

function deepMerge(base: BwrapConfig, overrides: Partial<BwrapConfig>): BwrapConfig {
  return {
    mode: overrides.mode ?? base.mode,
    bwrapPath: overrides.bwrapPath ?? base.bwrapPath,
    writablePaths: overrides.writablePaths ?? base.writablePaths,
    extraWritablePaths: [...base.extraWritablePaths, ...(overrides.extraWritablePaths ?? [])],
    tmpfsPaths: overrides.tmpfsPaths ?? base.tmpfsPaths,
    extraArgs: overrides.extraArgs ?? base.extraArgs,
    approvalRules: [...(base.approvalRules ?? []), ...(overrides.approvalRules ?? [])],
  };
}

function parseBwrapConfigFile(path: string): BwrapConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid bwrap configuration at ${path}: ${String(error)}`, { cause: error });
  }
  try {
    return Value.Parse(bwrapConfigFileSchema, raw);
  } catch (error) {
    throw new Error(`Invalid bwrap configuration at ${path}: ${String(error)}`, { cause: error });
  }
}

export interface BwrapConfigPaths {
  global: string;
  project: string;
}

export function getBwrapConfigPaths(cwd: string): BwrapConfigPaths {
  return {
    global: join(getAgentDir(), "bwrap.json"),
    project: join(cwd, ".pi", "bwrap.json"),
  };
}

export function loadBwrapConfig(cwd: string, paths = getBwrapConfigPaths(cwd)): BwrapConfig {
  let config = DEFAULT_CONFIG;
  for (const path of [paths.global, paths.project]) {
    if (!existsSync(path)) continue;
    config = deepMerge(config, parseBwrapConfigFile(path));
  }
  return Value.Parse(bwrapConfigSchema, config);
}

export function resolveBwrapPath(path: string, cwd: string): string {
  const expanded = expandHome(path);
  return expanded === "." ? cwd : expanded;
}

function findDefaultBwrap(): string {
  const pathEnv = process.env.PATH ?? "";
  for (const directory of pathEnv.split(delimiter)) {
    const candidate = join(directory, "bwrap");
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of [
    "/usr/bin/bwrap",
    "/usr/local/bin/bwrap",
    "/run/current-system/sw/bin/bwrap",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "bwrap (bubblewrap) not found in PATH. Install it:\n" +
      "  apt install bubblewrap (Debian/Ubuntu)\n" +
      "  pacman -S bubblewrap (Arch)\n" +
      "  dnf install bubblewrap (Fedora)",
  );
}

export function findBwrap(override?: string): string {
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`bwrap not found at configured path: ${override}`);
    }
    return override;
  }
  return findDefaultBwrap();
}

export function buildBwrapArgs(resolved: ResolvedBwrap, cwd: string): string[] {
  const args = ["--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid"];
  for (const path of resolved.writablePaths) {
    const absolutePath = resolveBwrapPath(path, cwd);
    args.push("--bind", absolutePath, absolutePath);
  }
  for (const path of resolved.extraWritablePaths) {
    const absolutePath = resolveBwrapPath(path, cwd);
    args.push("--bind", absolutePath, absolutePath);
  }
  for (const path of resolved.tmpfsPaths) {
    args.push("--tmpfs", resolveBwrapPath(path, cwd));
  }
  if (!resolved.network) args.push("--unshare-net");
  for (const name of PROTECTED_DIRS) {
    const absolutePath = join(cwd, name);
    if (existsSync(absolutePath)) args.push("--ro-bind", absolutePath, absolutePath);
  }
  args.push(...resolved.extraArgs);
  return args;
}

const SECCOMP_BPF_FILE = (() => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  if (process.arch === "x64") return join(directory, "seccomp-x86_64.bpf");
  if (process.arch === "arm64") return join(directory, "seccomp-aarch64.bpf");
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

function killChild(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function createBwrapBashOperations(resolved: ResolvedBwrap): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      await fsAccess(cwd, constants.F_OK).catch(() => {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      });
      if (signal?.aborted) throw new Error("aborted");

      const seccompFd = resolved.network ? undefined : getSeccompFd();
      const baseArgs = [
        "--ro-bind",
        "/",
        "/",
        ...buildBwrapArgs(resolved, cwd),
        "--dev",
        "/dev",
        "--proc",
        "/proc",
      ];
      const child = spawn(
        findBwrap(resolved.bwrapPath),
        seccompFd === undefined
          ? [...baseArgs, "--", "bash", "-c", command]
          : [...baseArgs, "--seccomp", "3", "--", "bash", "-c", command],
        {
          cwd,
          detached: true,
          stdio:
            seccompFd === undefined
              ? ["ignore", "pipe", "pipe"]
              : ["ignore", "pipe", "pipe", seccompFd],
          env: process.env,
        },
      );

      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let timedOut = false;
        const timeoutHandle = timeout
          ? setTimeout(() => {
              timedOut = true;
              killChild(child);
            }, timeout * 1000)
          : undefined;
        const onAbort = () => killChild(child);
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.once("error", reject);
        child.once("close", (exitCode) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          if (seccompFd !== undefined) closeSync(seccompFd);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode });
        });
      });
    },
  };
}
