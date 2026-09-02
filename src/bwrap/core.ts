import { type ChildProcess, spawn } from "node:child_process";
import { constants, type Dirent, existsSync, readFileSync } from "node:fs";
import { access as fsAccess, readdir, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import { type BashOperations, getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { parseWithSchema } from "../lib/parse-with-schema.js";
import { expandHome } from "../lib/path.js";
import { type ApprovalRule } from "./approval-rules.js";
import {
  type NetworkStack,
  resolveDnsServers,
  startNetworkStack,
  TimeoutError,
} from "./network-stack.js";

const PROTECTED_DIRS = [".pi", ".agent"];

export const BWRAP_MODES = [
  "allow-all",
  "workspace-write",
  "allow-net",
  "net-allowlist",
  "readonly",
] as const;

export type BwrapMode = (typeof BWRAP_MODES)[number];

const bwrapConfigProperties = {
  mode: StringEnum(BWRAP_MODES),
  bwrapPath: Type.Optional(Type.String()),
  writablePaths: Type.Array(Type.String()),
  extraWritablePaths: Type.Array(Type.String()),
  denyPaths: Type.Array(
    Type.String({
      description:
        "沙箱内隐藏的路径：以 / 结尾为目录（挂空 tmpfs），否则为文件（--ro-bind-try /dev/null）",
    }),
  ),
  extraArgs: Type.Array(Type.String()),
  networkAllowlist: Type.Array(
    Type.String({ description: "允许直连的域名 / IP / CIDR，可带 :port" }),
  ),
  mihomoPath: Type.Optional(Type.String()),
  slirp4netnsPath: Type.Optional(Type.String()),
  approvalRules: Type.Optional(
    Type.Array(
      Type.Object(
        {
          action: StringEnum(["allow", "deny"] as const),
          pattern: Type.String({ description: '命令模式，如 "git push *"、"npm install *"' }),
        },
        { additionalProperties: true },
      ),
    ),
  ),
};

// 配置文件容忍未知字段：schema 之外的字段（如新版本扩展新增的配置）会被忽略，
// 避免整个 bwrap 配置因单个未知字段失效；已声明字段仍做类型/取值校验。
export const bwrapConfigSchema = Type.Object(bwrapConfigProperties, {
  additionalProperties: true,
});

export const bwrapConfigFileSchema = Type.Partial(bwrapConfigSchema, {
  additionalProperties: true,
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
  /** 沙箱内隐藏的路径：以 / 结尾为目录（挂空 tmpfs），否则为文件（--ro-bind-try /dev/null）。 */
  denyPaths: string[];
  extraArgs: string[];
  /** 允许直连的域名 / IP / IP:port 白名单（非空 = 启用 mihomo 网络过滤）。 */
  networkAllowlist: string[];
  mihomoPath?: string;
  slirp4netnsPath?: string;
  /** 全权限执行的自动审批规则（allow/deny 命令模式）。 */
  approvalRules: ApprovalRule[];
}

const DEFAULT_CONFIG: BwrapConfig = {
  mode: "workspace-write",
  writablePaths: [".", "/tmp"],
  extraWritablePaths: [],
  denyPaths: [],
  extraArgs: [],
  networkAllowlist: [],
};

export function resolveBwrap(config: BwrapConfig): ResolvedBwrap {
  const base = {
    mode: config.mode,
    bwrapPath: config.bwrapPath,
    writablePaths: config.writablePaths,
    extraWritablePaths: config.extraWritablePaths,
    denyPaths: config.denyPaths,
    extraArgs: config.extraArgs,
    networkAllowlist: config.networkAllowlist,
    mihomoPath: config.mihomoPath,
    slirp4netnsPath: config.slirp4netnsPath,
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
    case "net-allowlist": {
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
    denyPaths: [],
    extraArgs: [],
  });
}

function deepMerge(base: BwrapConfig, overrides: Partial<BwrapConfig>): BwrapConfig {
  return {
    mode: overrides.mode ?? base.mode,
    bwrapPath: overrides.bwrapPath ?? base.bwrapPath,
    writablePaths: overrides.writablePaths ?? base.writablePaths,
    extraWritablePaths: [...base.extraWritablePaths, ...(overrides.extraWritablePaths ?? [])],
    denyPaths: overrides.denyPaths ?? base.denyPaths,
    extraArgs: overrides.extraArgs ?? base.extraArgs,
    networkAllowlist: overrides.networkAllowlist ?? base.networkAllowlist,
    mihomoPath: overrides.mihomoPath ?? base.mihomoPath,
    slirp4netnsPath: overrides.slirp4netnsPath ?? base.slirp4netnsPath,
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
    return parseWithSchema(bwrapConfigFileSchema, raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid bwrap configuration at ${path}: ${detail}`, { cause: error });
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
  // 去重：调用方用同一路径表达「只读这一个文件」时不做二次合并
  // （否则 extraWritablePaths / approvalRules 会被重复拼接）
  for (const path of new Set([paths.global, paths.project])) {
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

function findCommandInPath(name: string, hint: string): string {
  const pathEnv = process.env.PATH ?? "";
  for (const directory of pathEnv.split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(hint);
}

// npm 包内自带的静态编译 mihomo（linux-x64），发布时由 CI 下载到 vendor/；
// 源码方式运行（vendor 不存在）时自然跳过，走 PATH 查找。
const VENDORED_MIHOMO_PATH = fileURLToPath(
  new URL("../../vendor/mihomo-linux-x64", import.meta.url),
);

export function findMihomo(override?: string, bundledPath = VENDORED_MIHOMO_PATH): string {
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`mihomo not found at configured path: ${override}`);
    }
    return override;
  }
  // 优先全局 PATH（用户自装的 mihomo），没有时回退到包内自带二进制
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "mihomo");
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(bundledPath)) return bundledPath;
  throw new Error(
    "mihomo not found in PATH and the package ships no bundled binary. " +
      "Install it from https://github.com/MetaCubeX/mihomo",
  );
}

export function findSlirp4netns(override?: string): string {
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`slirp4netns not found at configured path: ${override}`);
    }
    return override;
  }
  return findCommandInPath(
    "slirp4netns",
    "slirp4netns not found in PATH. Install it from https://github.com/rootless-containers/slirp4netns",
  );
}

/** 扫描 .git 时跳过的目录：包/依赖/构建产物，嵌套 git 仓库几乎不会出现在这里。 */
const GIT_DIR_SCAN_SKIP = new Set([
  "node_modules",
  ".venv",
  "venv",
  ".venvs",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".next",
  ".cache",
  ".turbo",
  ".pytest_cache",
  ".mypy_cache",
  ".hg",
  ".svn",
]);

/** 最多收集的 .git 数量与扫描深度，防止异常大的工作区拖慢每条命令。 */
const MAX_GIT_DIRS = 64;
const MAX_GIT_SCAN_DEPTH = 24;

class ScanLimitError extends Error {}

/**
 * 递归扫描工作区，收集所有 `.git` 目录的绝对路径（monorepo / 嵌套仓库）。
 * 达到数量上限立即停止整棵遍历；跳过 symlink（防循环）与无法读取的目录。
 */
export async function findGitDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_GIT_SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_GIT_DIRS) throw new ScanLimitError();
      if (entry.name === ".git" && entry.isDirectory()) {
        found.push(join(dir, ".git"));
        continue;
      }
      if (!entry.isDirectory() || GIT_DIR_SCAN_SKIP.has(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  };
  try {
    await walk(root, 0);
  } catch (error) {
    if (!(error instanceof ScanLimitError)) throw error;
  }
  return found;
}

export async function buildBwrapArgs(resolved: ResolvedBwrap, cwd: string): Promise<string[]> {
  const args = ["--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid"];
  // --*-bind-try：配置的路径不存在时忽略该项而不是让整条命令失败
  for (const path of resolved.writablePaths) {
    const absolutePath = resolveBwrapPath(path, cwd);
    args.push("--bind-try", absolutePath, absolutePath);
  }
  for (const path of resolved.extraWritablePaths) {
    const absolutePath = resolveBwrapPath(path, cwd);
    args.push("--bind-try", absolutePath, absolutePath);
  }
  // denyPaths：以 / 结尾的条目视为目录（挂空 tmpfs），否则视为文件（--ro-bind-try /dev/null 覆盖）
  for (const path of resolved.denyPaths) {
    const target = resolveBwrapPath(path, cwd);
    if (path.endsWith("/")) {
      args.push("--tmpfs", target);
    } else {
      args.push("--ro-bind-try", "/dev/null", target);
    }
  }
  if (!resolved.network) args.push("--unshare-net");
  // --ro-bind-try：目录不存在（或已被删除）时自动忽略
  for (const name of PROTECTED_DIRS) {
    const absolutePath = join(cwd, name);
    args.push("--ro-bind-try", absolutePath, absolutePath);
  }
  // 工作区下所有 .git 一律只读：可写 bind 之上的覆盖绑定，防止命令篡改仓库元数据。
  // 根目录本身是 git 仓库时只保护根 .git（递归扫描有成本，绝大多数情况根即唯一仓库）；
  // 根不是 git 仓库时才递归扫描嵌套仓库（如 monorepo 子仓库）。
  const rootGit = join(cwd, ".git");
  let gitDirs: string[];
  try {
    await stat(rootGit);
    gitDirs = [rootGit];
  } catch {
    gitDirs = await findGitDirs(cwd);
  }
  for (const gitDir of gitDirs) {
    args.push("--ro-bind-try", gitDir, gitDir);
  }
  args.push(...resolved.extraArgs);
  return args;
}

function killChild(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** 网络栈子进程输出转发通道，仅用于诊断（默认丢弃）。 */
export interface NetworkStackLog {
  holder?: (chunk: string) => void;
}

/** 为 net-allowlist 模式创建网络栈；非该模式返回 undefined。每次命令现建现停。 */
export async function createNetworkStack(
  resolved: ResolvedBwrap,
  log?: NetworkStackLog,
): Promise<NetworkStack | undefined> {
  if (!resolved.network || resolved.networkAllowlist.length === 0) return undefined;
  return startNetworkStack({
    allowlist: resolved.networkAllowlist,
    dnsServers: await resolveDnsServers(),
    mihomoPath: findMihomo(resolved.mihomoPath),
    slirp4netnsPath: findSlirp4netns(resolved.slirp4netnsPath),
    ...(log?.holder && { onHolderOutput: log.holder }),
  });
}

/** 一次 bwrap 调用的完整组装结果：argv 与干净环境。 */
export interface BwrapInvocation {
  /** bwrap 可执行文件路径 */
  file: string;
  /** bwrap 参数（不含结尾的 `-- shell -lc command`） */
  args: string[];
  /** 沙箱内 shell 的绝对路径 */
  shell: string;
  /** 交给 shell 的命令 */
  command: string;
  /** 命令执行目录 */
  cwd: string;
  /** 沙箱内环境（不继承父进程） */
  env: Record<string, string>;
  /** net-allowlist 模式：命令需先经 nsenter 进入 holder 的 netns。 */
  needsNetworkStack: boolean;
}

/**
 * 组装一次 bwrap 调用。实际执行（createBwrapBashOperations）与调试打印共用这里，
 * 保证 `--print-args` 输出的命令行与真正跑的那条完全一致。
 */
export async function buildBwrapInvocation(
  resolved: ResolvedBwrap,
  workspace: string,
  command: string,
  cwd: string,
): Promise<BwrapInvocation> {
  // 干净环境：不继承父进程 env/PATH，由 bash -lc 从 /etc/profile 与用户 profile 重建
  const home = process.env.HOME;
  if (home === undefined) {
    throw new Error("HOME is not set; refusing to run bash in a clean environment");
  }
  return {
    // 沙箱内不透传 PATH，execvp 的默认路径可能找不到 bash（如 NixOS），故在父进程解析绝对路径
    shell: getShellConfig().shell,
    file: findBwrap(resolved.bwrapPath),
    args: [
      "--ro-bind",
      "/",
      "/",
      ...(await buildBwrapArgs(resolved, workspace)),
      "--dev",
      "/dev",
      "--proc",
      "/proc",
    ],
    command,
    cwd,
    env: {
      HOME: home,
      SHELL: "/bin/bash",
      TERM: "dumb",
      LANG: "C.UTF-8",
      // 基础 PATH：profile 加载阶段（设置 PATH 前）需要系统命令（如 id），由 profile 随后覆盖；不含 sbin
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    needsNetworkStack: resolved.network && resolved.networkAllowlist.length > 0,
  };
}

/** 完整 argv（`[bwrap, ...args, "--", shell, "-lc", command]`），spawn 与打印共用。 */
export function bwrapArgv(invocation: BwrapInvocation): string[] {
  return [invocation.file, ...invocation.args, "--", invocation.shell, "-lc", invocation.command];
}

/**
 * @param workspace session 工作区：writablePaths 的 "." 与 PROTECTED_DIRS 都基于它解析，
 *   与当次命令的 cwd（仅作为进程执行目录）解耦，避免 workdir 参数漂移可写边界。
 */
export function createBwrapBashOperations(
  resolved: ResolvedBwrap,
  workspace: string,
  networkStack?: NetworkStack,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      await fsAccess(cwd, constants.F_OK).catch(() => {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      });
      // 已中断（signal.reason 是 name=AbortError 的 DOMException）：直接抛，不再执行
      signal?.throwIfAborted();

      const invocation = await buildBwrapInvocation(resolved, workspace, command, cwd);

      if (invocation.needsNetworkStack) {
        if (!networkStack) {
          throw new Error("Network stack is not initialized for net-allowlist mode");
        }
        return networkStack.exec({
          command,
          cwd,
          bwrapPath: invocation.file,
          bwrapArgs: invocation.args,
          shell: invocation.shell,
          env: invocation.env,
          onData,
          signal,
          timeout,
        });
      }

      const argv = bwrapArgv(invocation);
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: invocation.env,
      });

      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let timedOut = false;
        const timeoutHandle = timeout
          ? setTimeout(() => {
              timedOut = true;
              killChild(child);
            }, timeout * 1000)
          : undefined;
        const onAbort = () => killChild(child);
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.once("error", reject);
        child.once("close", (exitCode) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          // 中断：reject signal.reason（默认是 name=AbortError 的 DOMException）
          if (signal?.aborted) {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("The operation was aborted"),
            );
          } else if (timedOut) {
            // 超时：name=TimeoutError（对齐标准错误分类）
            reject(new TimeoutError(timeout));
          } else resolve({ exitCode });
        });
      });
    },
  };
}
