/**
 * 执行层：把一次组装好的 bwrap 调用变成进程。
 *
 * 完整命令行只在这里组装（`invocationArgv`），子进程生命周期只有一份实现
 * （`execInvocation`）——direct 与经 `nsenter` 进 holder netns 两条路径共用，
 * 预览（`--print-args`）也走同一次组装，超时 / 中断 / 启动失败的错误语义与
 * 打印出的命令行因此不会漂移。argv 内容与配置解析由 core.ts 提供；holder pid
 * 由 network-stack.ts 提供，网络栈本身不知道 bwrap 参数怎么拼。
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";

import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import { buildBwrapArgs, findBwrap, type ResolvedBwrap } from "./core.js";
import type { NetworkStack } from "./network-stack.js";

/** 命令超时错误：name=TimeoutError（对齐标准错误分类），message 保留 timeout:N 格式。 */
export class TimeoutError extends Error {
  constructor(timeout: number | undefined) {
    super(`timeout:${timeout}`);
    this.name = "TimeoutError";
  }
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
  /** 沙箱内环境（不继承父进程） */
  env: Record<string, string>;
  /** network limited 模式：命令需先经 nsenter 进入 holder 的 netns。 */
  needsNetworkStack: boolean;
}

/**
 * 执行层自己的基础环境：不继承父进程 env/PATH，由 `bash -lc` 从 /etc/profile
 * 与用户 profile 重建。沙箱与本地两条路径共用这一份，差异只在权限。
 *
 * `extraEnv` 是配置注入的额外环境变量（`personalExtensions.shell.env`），同名时覆盖基础值。
 */
export function shellBaseEnv(extraEnv?: Readonly<Record<string, string>>): Record<string, string> {
  const home = process.env.HOME;
  if (home === undefined) {
    throw new Error("HOME is not set; refusing to run bash in a clean environment");
  }
  return {
    HOME: home,
    SHELL: "/bin/bash",
    TERM: "dumb",
    LANG: "C.UTF-8",
    // 基础 PATH：profile 加载阶段（设置 PATH 前）需要系统命令（如 id），由 profile 随后覆盖；不含 sbin
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ...extraEnv,
  };
}

/**
 * 组装一次 bwrap 调用。实际执行（`execInvocation`）与调试打印共用这里，
 * 保证 `--print-args` 输出的命令行与真正跑的那条完全一致。
 *
 * `extraEnv` 是配置注入的额外环境变量：合并进这份干净环境，同名时覆盖基础值。
 */
export async function buildBwrapInvocation(
  resolved: ResolvedBwrap,
  workspace: string,
  command: string,
  extraEnv?: Readonly<Record<string, string>>,
): Promise<BwrapInvocation> {
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
    env: shellBaseEnv(extraEnv),
    needsNetworkStack: resolved.network === "limited",
  };
}

/**
 * 完整命令行：`[bwrap, ...args, "--", shell, "-lc", command]`；传 `nsenterPid` 时
 * 前置 `nsenter` 前缀进入该 holder 的 userns + netns。
 *
 * 预览与实际执行都调用这里——`nsenterPid` 传数字是真实 holder pid，传字符串是
 * 尚未启动时的占位符（打印用），不传即纯 bwrap 命令行。
 */
export function invocationArgv(
  invocation: BwrapInvocation,
  nsenterPid?: number | string,
): string[] {
  const argv = [
    invocation.file,
    ...invocation.args,
    "--",
    invocation.shell,
    "-lc",
    invocation.command,
  ];
  if (nsenterPid === undefined) {
    return argv;
  }
  return ["nsenter", "-U", "-n", "--preserve-credentials", "-t", String(nsenterPid), "--", ...argv];
}

function killChild(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已退出
    }
  }
}

export interface ExecOptions {
  /** 命令执行目录（进程 cwd）。 */
  cwd: string;
  /** 流式输出回调（stdout 与 stderr 已合并）。 */
  onData: (data: Buffer) => void;
  /** 取消：终止整个进程组并以 signal.reason（默认 AbortError）结束。 */
  signal?: AbortSignal;
  /** 超时秒数：终止整个进程组并以 TimeoutError 结束。 */
  timeout?: number;
}

export interface ExecInvocationOptions extends ExecOptions {
  /** netns holder pid：invocation 需要网络栈时必填，缺失即抛错。 */
  holderPid?: number;
}

/**
 * 执行一条组装好的 argv（唯一一处 spawn 与生命周期）。沙箱路径传 bwrap 形式的
 * argv，本地路径传 `[shell, "-lc", command]`，超时 / 中断 / 进程组 kill 语义共用。
 *
 * 进程以独立进程组启动，超时与取消都终止整组，启动失败（spawn error）立即结束
 * 且不残留超时定时器。
 */
export function execArgv(
  argv: string[],
  env: Readonly<Record<string, string>>,
  options: ExecOptions,
): Promise<{ exitCode: number | null }> {
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    const timeoutHandle = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          killChild(child.pid);
        }, options.timeout * 1000)
      : undefined;
    const onAbort = (): void => {
      killChild(child.pid);
    };
    // 结算一次：无论走 error 还是 close，都清掉超时定时器与 abort 监听——挂着的
    // 定时器会白占事件循环到超时那一刻。
    const settle = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      options.signal?.removeEventListener("abort", onAbort);
      return true;
    };

    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      if (!settle()) {
        return;
      }
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (!settle()) {
        return;
      }
      // 中断：reject signal.reason（默认是 name=AbortError 的 DOMException）
      if (options.signal?.aborted) {
        reject(
          options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("The operation was aborted"),
        );
      } else if (timedOut) {
        // 超时：name=TimeoutError（对齐标准错误分类）
        reject(new TimeoutError(options.timeout));
      } else {
        resolve({ exitCode });
      }
    });
  });
}

/**
 * 执行一次组装好的 bwrap 调用：需要网络栈时自动前置 `nsenter` 前缀，其余交给
 * `execArgv`（与本地路径共用的 spawn 实现）。
 */
export function execInvocation(
  invocation: BwrapInvocation,
  options: ExecInvocationOptions,
): Promise<{ exitCode: number | null }> {
  if (invocation.needsNetworkStack && options.holderPid === undefined) {
    return Promise.reject(new Error("Network stack is not initialized for network limited mode"));
  }
  const argv = invocationArgv(
    invocation,
    invocation.needsNetworkStack ? options.holderPid : undefined,
  );
  return execArgv(argv, invocation.env, options);
}

/** 两条路径共用的执行前检查：目录必须存在，已中断则不再启动进程。 */
async function assertExecutable(cwd: string, signal: AbortSignal | undefined): Promise<void> {
  await fsAccess(cwd, constants.F_OK).catch(() => {
    throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
  });
  // 已中断（signal.reason 是 name=AbortError 的 DOMException）：直接抛，不再执行
  signal?.throwIfAborted();
}

/**
 * @param workspace session 工作区：writablePaths 的 "." 与 PROTECTED_DIRS 都基于它解析，
 *   与当次命令的 cwd（仅作为进程执行目录）解耦，避免 workdir 参数漂移可写边界。
 * @param extraEnv 配置注入的额外环境变量，覆盖沙箱环境里的同名基础值。
 */
export function createBwrapBashOperations(
  resolved: ResolvedBwrap,
  workspace: string,
  networkStack?: NetworkStack,
  extraEnv?: Readonly<Record<string, string>>,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      await assertExecutable(cwd, signal);

      const invocation = await buildBwrapInvocation(resolved, workspace, command, extraEnv);
      return execInvocation(invocation, {
        cwd,
        holderPid: networkStack?.holderPid,
        onData,
        signal,
        timeout,
      });
    },
  };
}

/**
 * 不经沙箱的 bash 执行：与 bwrap 路径共用同一份基础环境（`shellBaseEnv`）与同一段
 * spawn 实现（`execArgv`），argv 换成 `[shell, "-lc", command]`。两条路径的差异只有
 * 权限，工具版本因此都按 cwd 由登录 shell 的 profile 解析。
 *
 * @param extraEnv 配置注入的额外环境变量，覆盖基础环境里的同名值。
 */
export function createLocalBashOperations(
  extraEnv?: Readonly<Record<string, string>>,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      await assertExecutable(cwd, signal);
      return execArgv([getShellConfig().shell, "-lc", command], shellBaseEnv(extraEnv), {
        cwd,
        onData,
        signal,
        timeout,
      });
    },
  };
}
