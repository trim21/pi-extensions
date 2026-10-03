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
  /** bwrap 参数（不含结尾的 `-- <commandArgv>`） */
  args: string[];
  /**
   * 沙箱内要执行的命令行（`--` 之后的部分，逐项给出）。
   * 常见形态是 `bash -lc <命令>`（见 `shellCommandArgv`），codemode 则传 `node <脚本>`。
   */
  commandArgv: string[];
  /** 沙箱内环境（不继承父进程） */
  env: Record<string, string>;
  /** network limited 模式：命令需先经 nsenter 进入 holder 的 netns。 */
  needsNetworkStack: boolean;
}

/** bash 形态的命令行：`<shell> -lc <command>`。命令字符串只有这一条入口。 */
export function shellCommandArgv(command: string): string[] {
  // 沙箱内不透传 PATH，execvp 的默认路径可能找不到 bash（如 NixOS），故在父进程解析绝对路径
  return [getShellConfig().shell, "-lc", command];
}

/** 沙箱内的干净环境：不继承父进程 env/PATH。bash 由 profile 重建 PATH，node 用给出的 PATH。 */
export function sandboxEnv(): Record<string, string> {
  const home = process.env.HOME;
  if (home === undefined) {
    throw new Error("HOME is not set; refusing to run in a clean environment");
  }
  return {
    HOME: home,
    SHELL: "/bin/bash",
    TERM: "dumb",
    LANG: "C.UTF-8",
    // 基础 PATH：profile 加载阶段（设置 PATH 前）需要系统命令（如 id），由 profile 随后覆盖；不含 sbin
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
}

/**
 * 组装一次 bwrap 调用。实际执行（`execInvocation`）与调试打印共用这里，
 * 保证 `--print-args` 输出的命令行与真正跑的那条完全一致。
 */
export async function buildBwrapInvocation(
  resolved: ResolvedBwrap,
  workspace: string,
  commandArgv: readonly string[],
): Promise<BwrapInvocation> {
  return {
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
    commandArgv: [...commandArgv],
    env: sandboxEnv(),
    needsNetworkStack: resolved.network === "limited",
  };
}

/**
 * 完整命令行：`[bwrap, ...args, "--", ...commandArgv]`；传 `nsenterPid` 时
 * 前置 `nsenter` 前缀进入该 holder 的 userns + netns。
 *
 * 预览与实际执行都调用这里——`nsenterPid` 传数字是真实 holder pid，传字符串是
 * 尚未启动时的占位符（打印用），不传即纯 bwrap 命令行。
 */
export function invocationArgv(
  invocation: BwrapInvocation,
  nsenterPid?: number | string,
): string[] {
  const argv = [invocation.file, ...invocation.args, "--", ...invocation.commandArgv];
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

export interface ExecInvocationOptions {
  /** 命令执行目录（进程 cwd）；沙箱内可写边界由 invocation 的挂载项决定，与此无关。 */
  cwd: string;
  /** netns holder pid：invocation 需要网络栈时必填，缺失即抛错。 */
  holderPid?: number;
  /** 流式输出回调（stdout 与 stderr 已合并）。 */
  onData: (data: Buffer) => void;
  /** 取消：终止整个进程组并以 signal.reason（默认 AbortError）结束。 */
  signal?: AbortSignal;
  /** 超时秒数：终止整个进程组并以 TimeoutError 结束。 */
  timeout?: number;
}

/**
 * 执行一次组装好的调用（唯一一处 spawn 与生命周期）。
 *
 * 需要网络栈时自动前置 `nsenter` 前缀；进程以独立进程组启动，超时与取消都
 * 终止整组，启动失败（spawn error）立即结束且不残留超时定时器。
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
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: invocation.env,
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

      const invocation = await buildBwrapInvocation(resolved, workspace, shellCommandArgv(command));
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
