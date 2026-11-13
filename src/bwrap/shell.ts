/**
 * 不经沙箱的本地执行路径，以及两条路径共用的命令环境。
 *
 * 环境只由执行层自己的基础值与配置注入的 `personalExtensions.shell.env` 组成，不继承
 * 父进程：沙箱路径把它放进执行策略交给原生执行器，本地路径用同一份环境 spawn，
 * 交给 shell 的变量集合因此逐项相同，差异只有权限。
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import process from "node:process";

import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import { TimeoutError } from "./executor.js";

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

interface ExecOptions {
  /** 命令执行目录（进程 cwd）。 */
  cwd: string;
  /** 流式输出回调（stdout 与 stderr 已合并）。 */
  onData: (data: Buffer) => void;
  /** 取消：终止整个进程组并以 signal.reason（默认 AbortError）结束。 */
  signal?: AbortSignal;
  /** 超时秒数：终止整个进程组并以 TimeoutError 结束。 */
  timeout?: number;
}

/**
 * 本地路径的 spawn 与生命周期：进程以独立进程组启动，超时与取消都终止整组，
 * 启动失败（spawn error）立即结束且不残留超时定时器。
 */
function execArgv(
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

/** 执行前检查：目录必须存在，已中断则不再启动进程。 */
async function assertExecutable(cwd: string, signal: AbortSignal | undefined): Promise<void> {
  await fsAccess(cwd, constants.F_OK).catch(() => {
    throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
  });
  // 已中断（signal.reason 是 name=AbortError 的 DOMException）：直接抛，不再执行
  signal?.throwIfAborted();
}

/**
 * 不经沙箱的 bash 执行：与沙箱路径共用同一份基础环境（`shellBaseEnv`），argv 是
 * `[shell, "-lc", command]`。两条路径的差异只有权限，工具版本因此都按 cwd 由登录
 * shell 的 profile 解析。
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
