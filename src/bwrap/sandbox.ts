/**
 * 纯沙箱执行层：加载配置 → 解析执行策略 → 需要时现建 netns 网络栈 → 在 bwrap 里跑命令。
 *
 * 这里刻意不含 UI、审批与会话上下文（那些属于扩展层 runtime.ts）：
 * pi 的 Bash 工具、`node bin/sandbox.ts` 和集成测试共用这条路径，
 * 因此沙箱行为可以脱离 agent 循环单独复现和验证。
 *
 * 唯一的调用方交互是 `onData`（流式输出）与 `signal` / `timeout`（取消）；
 * `log` / `onNetworkStack` 是诊断出口，用于看 holder（unshare + mihomo）与
 * slirp4netns 的原始日志——网络栈起不来时只有它们能说明原因。
 */

import { existsSync } from "node:fs";

import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

import { expandHome } from "../lib/path.js";
import {
  buildBwrapInvocation,
  bwrapArgv,
  type BwrapConfig,
  type BwrapMode,
  createBwrapBashOperations,
  createNetworkStack,
  getBwrapConfigPaths,
  loadBwrapConfig,
  type NetworkStackLog,
  resolveBwrap,
  resolveBwrapPath,
  type ResolvedBwrap,
  resolveHeadlessBwrap,
} from "./core.js";
import type { NetworkStack } from "./network-stack.js";

export interface SandboxConfigInput {
  /** 沙箱工作区：默认配置文件的查找目录，也是 writablePaths 中 "." 的解析基准。 */
  workspace: string;
  /** 只使用该配置文件（跳过全局 + 项目两级合并）。 */
  configPath?: string;
  /** 覆盖配置中的 mode（等价于会话内切 /bwrap 模式）。 */
  mode?: BwrapMode;
  /** 无 UI 会话策略：无论配置如何都强制 readonly。 */
  headless?: boolean;
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
  /** 取消执行：kill 整个进程组并以 AbortError 结束。 */
  signal?: AbortSignal;
  /** 超时秒数：kill 整个进程组并以 TimeoutError 结束。 */
  timeout?: number;
  /** 调用方已决定不经沙箱（审批通过的全权限、Windows）。allow-all 模式无需显式设置。 */
  unsandboxed?: boolean;
  /** 网络栈子进程输出转发，仅诊断用（默认丢弃）。 */
  log?: NetworkStackLog;
  /** 网络栈就绪回调：取 holder pid 与 mihomo 配置路径手动排查。 */
  onNetworkStack?: (stack: NetworkStack) => void;
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
  const configured: BwrapConfig =
    input.mode === undefined ? config : { ...config, mode: input.mode };
  const resolved =
    input.headless === true ? resolveHeadlessBwrap(configured) : resolveBwrap(configured);
  return resolveSandboxPaths(resolved, workspace);
}

/**
 * 在 resolved 描述的沙箱里执行一条命令；net-allowlist 模式下现建现停网络栈。
 * 超时与取消的错误语义由底层 operations.exec 抛出（TimeoutError / AbortError）。
 */
export async function runInSandbox(
  resolved: ResolvedBwrap,
  options: SandboxRunOptions,
): Promise<SandboxRunResult> {
  const workspace = expandHome(options.workspace);
  const commandCwd = expandHome(options.commandCwd ?? workspace);
  const local = options.unsandboxed === true || !resolved.bwrapEnabled;
  // 每次执行现建网络栈（启动约 140ms），作用域结束即停栈：allowlist 变更即时生效
  const stack = local ? undefined : await createNetworkStack(resolved, options.log);
  try {
    if (stack) {
      options.onNetworkStack?.(stack);
    }
    const operations = local
      ? createLocalBashOperations()
      : createBwrapBashOperations(resolved, workspace, stack);
    const { exitCode } = await operations.exec(options.command, commandCwd, {
      onData: options.onData,
      signal: options.signal,
      timeout: options.timeout,
    });
    return { exitCode };
  } finally {
    try {
      await stack?.stop();
    } catch {
      // best-effort：停栈失败（进程已退出/目录删除失败）不掩盖命令结果
    }
  }
}

/** 一步式入口：按配置加载策略并在对应沙箱里执行命令（CLI 与集成测试用）。 */
export async function runSandboxCommand(
  options: SandboxConfigInput & Omit<SandboxRunOptions, "unsandboxed">,
): Promise<SandboxRunResult> {
  return runInSandbox(loadSandboxConfig(options), options);
}

/** holder 尚未启动时，预览 argv 中标记 holder pid 位置的占位符。 */
export const HOLDER_PID_PLACEHOLDER = "<HOLDER_PID>";

export interface SandboxPreview {
  /** 完整 argv，逐项给出（结构化输出，不拼 shell 文本，无需 quoting 即可读懂）。 */
  argv: string[];
  /** 沙箱内环境（不继承父进程）。 */
  env: Record<string, string>;
  /** 需要先有 netns holder 才能真正执行（此时 argv 中的 pid 可能是 HOLDER_PID_PLACEHOLDER）。 */
  needsNetworkStack: boolean;
}

/**
 * 打印将要执行的命令行（`--print-args`）。与 runInSandbox 共用同一段组装逻辑，
 * 不存在「打印的是一回事、跑的是另一回事」的漂移。
 */
export async function previewSandboxCommand(
  resolved: ResolvedBwrap,
  options: Pick<SandboxRunOptions, "workspace" | "command" | "commandCwd" | "unsandboxed"> & {
    holderPid?: number;
  },
): Promise<SandboxPreview> {
  const workspace = expandHome(options.workspace);
  const commandCwd = expandHome(options.commandCwd ?? workspace);
  const invocation = await buildBwrapInvocation(resolved, workspace, options.command, commandCwd);
  if (!invocation.needsNetworkStack || options.unsandboxed === true) {
    return { argv: bwrapArgv(invocation), env: invocation.env, needsNetworkStack: false };
  }
  return {
    // 与 network-stack.ts 的实际 spawn 一致；holder 未启动时用占位符标出 pid 的位置
    argv: [
      "nsenter",
      "-U",
      "-n",
      "--preserve-credentials",
      "-t",
      options.holderPid === undefined ? HOLDER_PID_PLACEHOLDER : String(options.holderPid),
      "--",
      ...bwrapArgv(invocation),
    ],
    env: invocation.env,
    needsNetworkStack: true,
  };
}
