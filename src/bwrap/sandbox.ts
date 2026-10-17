/**
 * 纯沙箱执行层：加载配置 → 解析执行策略 → 需要时驱动原生执行器跑命令。
 *
 * 这里刻意不含 UI、审批与会话上下文（那些属于扩展层 runtime.ts）：
 * pi 的 Bash 工具、`node bin/sandbox.ts` 和集成测试共用这条路径，
 * 因此沙箱行为可以脱离 agent 循环单独复现和验证。
 *
 * 唯一的调用方交互是 `onData`（流式输出）与 `signal` / `timeout`（取消）；
 * `log` 是诊断出口，用于看执行器（网络栈 / slirp4netns）的原始日志——网络栈起不来时
 * 只有它们能说明原因。
 */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import process from "node:process";

import { createLocalBashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import { expandHome } from "../lib/path.js";
import {
  buildMountPlan,
  type BwrapConfig,
  type ExecutorDiagnostics,
  findBwrap,
  type FsMode,
  getBwrapConfigPaths,
  loadBwrapConfig,
  type NetworkMode,
  resolveBwrap,
  resolveBwrapPath,
  type ResolvedBwrap,
} from "./core.js";
import {
  MIHOMO_TUN_MTU,
  resolveDnsServers,
  resolveMihomoPath,
  resolveSlirp4netnsPath,
  runSandboxExecutor,
  type SandboxPolicy,
} from "./executor.js";

export interface SandboxConfigInput {
  /** 沙箱工作区：默认配置文件的查找目录，也是 writablePaths 中 "." 的解析基准。 */
  workspace: string;
  /** 只使用该配置文件（跳过全局 + 项目两级合并）。 */
  configPath?: string;
  /** 覆盖配置中的 fs.mode（等价于会话内切 /bwrap-fs-* 模式）。 */
  fsMode?: FsMode;
  /** 覆盖配置中的 network.mode（等价于会话内切 /bwrap-network-* 模式）。 */
  networkMode?: NetworkMode;
}

export interface SandboxRunOptions {
  /** 沙箱工作区（可写边界与 .git 只读保护的基准），与命令执行目录解耦。 */
  workspace: string;
  /** 交给 `shell -lc` 的命令字符串。 */
  command: string;
  /** 命令执行目录，缺省同 workspace。 */
  commandCwd?: string;
  /** 流式输出回调（stdout 与 stderr 已合并）。 */
  onData: (data: Buffer) => void;
  /** 取消执行：关执行器 stdin 触发内核级清理，必要时再终止执行器进程。 */
  signal?: AbortSignal;
  /** 超时秒数：交给执行器处理（pidfd 终止），以 TimeoutError 结束。 */
  timeout?: number;
  /** 调用方已决定不经沙箱（审批通过的全权限、Windows）。fs 与 network 均 allow-all 时无需显式设置。 */
  unsandboxed?: boolean;
  /** 执行器诊断输出转发（`[netstack] ` 前缀行），默认丢弃。 */
  log?: ExecutorDiagnostics;
}

export interface SandboxRunResult {
  /** 命令退出码；被信号杀死时为 null。 */
  exitCode: number | null;
}

/** 把 "."/"~" 形式的路径收敛成绝对路径，使执行策略自成一体、可断言。 */
function resolveSandboxPaths(resolved: ResolvedBwrap, workspace: string): ResolvedBwrap {
  const expand = (paths: string[]): string[] =>
    paths.map((path) => resolveBwrapPath(path, workspace));
  return {
    ...resolved,
    writablePaths: expand(resolved.writablePaths),
    extraWritablePaths: expand(resolved.extraWritablePaths),
    denyPaths: expand(resolved.denyPaths),
  };
}

/** 加载 bwrap 配置并解析成执行策略（配置文件缺失字段回落到默认值）。 */
export function loadSandboxConfig(input: SandboxConfigInput): ResolvedBwrap {
  const workspace = expandHome(input.workspace);
  const configPath = input.configPath === undefined ? undefined : expandHome(input.configPath);
  // 显式指定的配置文件必须存在：拼错路径时静默回落到默认值会让调试结论失效
  if (configPath !== undefined && !existsSync(configPath)) {
    throw new Error(`bwrap configuration file not found: ${configPath}`);
  }
  const paths =
    configPath === undefined
      ? getBwrapConfigPaths(workspace)
      : // 同一文件两侧：loadBwrapConfig 内部去重，等价于「只读这一个文件」
        { global: configPath, project: configPath };
  const config: BwrapConfig = loadBwrapConfig(workspace, paths);
  const configured: BwrapConfig = {
    ...config,
    fs: { ...config.fs, ...(input.fsMode !== undefined && { mode: input.fsMode }) },
    network: {
      ...config.network,
      ...(input.networkMode !== undefined && { mode: input.networkMode }),
    },
  };
  return resolveSandboxPaths(resolveBwrap(configured), workspace);
}

interface SandboxPolicyInput {
  /** writablePaths 中 "." 与 PROTECTED_DIRS / .git 的解析基准。 */
  workspace: string;
  command: string;
  commandCwd: string;
  timeout?: number;
}

/**
 * 把执行策略（ResolvedBwrap + 本次命令）翻译成执行器的能力描述。
 * 路径语义（realpath、"." 展开、工作区保护）在这一步全部落地；执行器只按计划翻译 bwrap 参数。
 */
async function buildSandboxPolicy(
  resolved: ResolvedBwrap,
  input: SandboxPolicyInput,
): Promise<SandboxPolicy> {
  const home = process.env.HOME;
  if (home === undefined) {
    throw new Error("HOME is not set; refusing to run bash in a clean environment");
  }
  const plan = await buildMountPlan(resolved, input.workspace);
  const limited = resolved.network === "limited";
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return {
    root: plan.root,
    mounts: plan.mounts,
    extraArgs: resolved.extraArgs,
    network: {
      mode: resolved.network,
      allowlist: resolved.networkAllowlist,
      // DNS 服务器由 TS 读取（执行器不自行发现）；只有 limited 模式用得上
      dnsServers: limited ? await resolveDnsServers() : [],
    },
    mihomo: { path: limited ? resolveMihomoPath(resolved.mihomoPath) : "", mtu: MIHOMO_TUN_MTU },
    slirp4netns: { path: limited ? resolveSlirp4netnsPath(resolved.slirp4netnsPath) : "" },
    bwrap: { path: findBwrap(resolved.bwrapPath) },
    command: input.command,
    // 沙箱内不透传 PATH，execvp 的默认路径可能找不到 bash（如 NixOS），故在父进程解析绝对路径
    shell: getShellConfig().shell,
    cwd: input.commandCwd,
    // 干净环境：不继承父进程 env/PATH，由 bash -lc 从 /etc/profile 与用户 profile 重建
    env: {
      HOME: home,
      SHELL: "/bin/bash",
      TERM: "dumb",
      LANG: "C.UTF-8",
      // 基础 PATH：profile 加载阶段（设置 PATH 前）需要系统命令（如 id），由 profile 随后覆盖；不含 sbin
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    ...(uid !== undefined && { uid }),
    ...(gid !== undefined && { gid }),
    // 执行器用整数秒；小数向上取整，避免 0 < timeout < 1 被折算成"无超时"
    timeoutSeconds: input.timeout === undefined ? 0 : Math.max(1, Math.ceil(input.timeout)),
  };
}

/**
 * 在 resolved 描述的沙箱里执行一条命令；沙箱路径交给原生执行器（网络栈由它现建现停）。
 * 超时与取消的错误语义由执行器与本地 operations 抛出（TimeoutError / AbortError）。
 */
export async function runInSandbox(
  resolved: ResolvedBwrap,
  options: SandboxRunOptions,
): Promise<SandboxRunResult> {
  const workspace = expandHome(options.workspace);
  const commandCwd = expandHome(options.commandCwd ?? workspace);
  const local = options.unsandboxed === true || !resolved.bwrapEnabled;
  if (local) {
    const operations = createLocalBashOperations();
    const { exitCode } = await operations.exec(options.command, commandCwd, {
      onData: options.onData,
      signal: options.signal,
      timeout: options.timeout,
    });
    return { exitCode };
  }
  // cwd 不存在时执行器会以用法错误退出，这里先给出与本地执行一致的明确错误
  await stat(commandCwd).catch(() => {
    throw new Error(
      `Working directory does not exist: ${commandCwd}\nCannot execute bash commands.`,
    );
  });
  const policy = await buildSandboxPolicy(resolved, {
    workspace,
    command: options.command,
    commandCwd,
    ...(options.timeout !== undefined && { timeout: options.timeout }),
  });
  const { exitCode } = await runSandboxExecutor(policy, {
    onData: options.onData,
    ...(options.signal !== undefined && { signal: options.signal }),
    ...(options.log?.diagnostic && { onDiagnostic: options.log.diagnostic }),
  });
  return { exitCode };
}

/** 一步式入口：按配置加载策略并在对应沙箱里执行命令（CLI 与集成测试用）。 */
export async function runSandboxCommand(
  options: SandboxConfigInput & Omit<SandboxRunOptions, "unsandboxed">,
): Promise<SandboxRunResult> {
  return runInSandbox(loadSandboxConfig(options), options);
}
