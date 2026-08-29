import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateMihomoConfig, TUN_MTU } from "./mihomo-config.js";

/** 命令超时错误：name=TimeoutError（对齐标准错误分类），message 保留 timeout:N 格式。 */
export class TimeoutError extends Error {
  constructor(timeout: number | undefined) {
    super(`timeout:${timeout}`);
    this.name = "TimeoutError";
  }
}

export interface NetworkStackOptions {
  /** 允许直连的域名 / IP:port 列表（每次命令从配置重新读取）。 */
  readonly allowlist: readonly string[];
  /** 真实 DNS 服务器列表，按顺序 fallback。 */
  readonly dnsServers: readonly string[];
  readonly mihomoPath: string;
  readonly slirp4netnsPath: string;
}

export interface NetworkStackExecOptions {
  readonly command: string;
  readonly cwd: string;
  readonly bwrapPath: string;
  /** bwrap 的完整参数（不含 -- 后的 shell 与命令），由 core.ts 组装。 */
  readonly bwrapArgs: readonly string[];
  readonly shell: string;
  readonly env: Readonly<Record<string, string>>;
  readonly onData: (data: Buffer) => void;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

const NAMESERVER_PATTERN = /^\s*nameserver\s+(\S+)/;
const HOLDER_PATH = fileURLToPath(new URL("holder.ts", import.meta.url));
// ip 通常位于 /usr/sbin 或 /sbin，进程默认 PATH 不含它们；node 则依赖宿主完整 PATH
const SBIN_PATH_SUFFIX = "/usr/local/sbin:/usr/sbin:/sbin";

function killProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 已退出
  }
}

/** 读宿主机 /etc/resolv.conf 的全部 IPv4 nameserver，按声明顺序返回。 */
export async function resolveDnsServers(): Promise<string[]> {
  const content = await readFile("/etc/resolv.conf", "utf8");
  const nameservers = content
    .split("\n")
    .map((line) => NAMESERVER_PATTERN.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  // slirp4netns 出口仅 IPv4，IPv6 nameserver 无法出站，故只保留 IPv4
  const ipv4 = nameservers.filter((value) => !value.includes(":"));
  if (ipv4.length === 0) {
    throw new Error("No IPv4 nameserver found in /etc/resolv.conf");
  }
  return ipv4;
}

/** 等待目标进程进入新的 user namespace（unshare 完成），返回后 slirp4netns 才能 setns。 */
async function waitForNewUserns(pid: number, timeoutMs = 5000): Promise<void> {
  const self = await readlink("/proc/self/ns/user");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readlink(`/proc/${pid}/ns/user`)) !== self) return;
    } catch {
      // /proc/<pid> 尚未就绪，重试
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for sandbox network namespace");
}

/** 监听 holder 的 stdout/stderr（mihomo 日志透传），以 "Tun adapter listening" 作为就绪标志。 */
function waitForMihomoStarted(holder: ChildProcess, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Timed out waiting for mihomo to start"));
    }, timeoutMs);
    const onData = (data: Buffer): void => {
      if (settled) return;
      if (data.toString().includes("Tun adapter listening")) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    holder.stdout?.on("data", onData);
    holder.stderr?.on("data", onData);
    holder.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Sandbox holder exited before mihomo started (code ${code})`));
    });
  });
}

function killChild(pid: number | undefined): void {
  if (!pid) return;
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

export interface NetworkStack {
  exec(options: NetworkStackExecOptions): Promise<{ exitCode: number | null }>;
  stop(): Promise<void>;
}

interface NetworkStackState {
  holderPid: number;
  slirpPid: number | undefined;
  directory: string;
}

/** 兜底：调用方忘记 stop() 时，对象被 GC 回收后 kill 残留进程并清理目录。 */
const stackFinalizer = new FinalizationRegistry<NetworkStackState>((state) => {
  killProcess(state.slirpPid);
  killProcess(state.holderPid);
  void rm(state.directory, { recursive: true, force: true }).catch(() => false);
});

/**
 * 启动网络栈：holder 进程持有 netns（内部跑 mihomo 的
 * TUN + fakeip + deny-by-default），slirp4netns 提供 egress。返回前
 * netns/mihomo/slirp4netns 均已就绪，命令通过 nsenter 进入该 netns 执行。
 */
export async function startNetworkStack(options: NetworkStackOptions): Promise<NetworkStack> {
  const { allowlist, dnsServers, mihomoPath, slirp4netnsPath } = options;
  const directory = await mkdtemp(join(tmpdir(), "pi-netns-"));
  const configPath = join(directory, "mihomo.json");
  const config = generateMihomoConfig({ allowlist, dnsServers });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const holder = spawn("unshare", ["-Urn", "--", "node", HOLDER_PATH, configPath, mihomoPath], {
    env: {
      HOME: process.env.HOME ?? "",
      PATH: `${process.env.PATH ?? ""}:${SBIN_PATH_SUFFIX}`,
    },
    // mihomo 日志经 holder 透传到这里的 stdout/stderr，用于判定就绪
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (holder.pid === undefined) {
    throw new Error("Failed to start network namespace holder");
  }
  const holderPid = holder.pid;
  await waitForNewUserns(holderPid);

  const slirp = spawn(
    slirp4netnsPath,
    [
      "-c",
      `--mtu=${TUN_MTU}`,
      `--userns-path=/proc/${holderPid}/ns/user`,
      "--netns-type=pid",
      String(holderPid),
      "tap0",
    ],
    { stdio: "ignore" },
  );
  const slirpPid = slirp.pid;
  await waitForMihomoStarted(holder);

  const state: NetworkStackState = { holderPid, slirpPid, directory };
  const stack: NetworkStack = {
    exec: async (execOptions: NetworkStackExecOptions) => {
      const child = spawn(
        "nsenter",
        [
          "-U",
          "-n",
          "--preserve-credentials",
          "-t",
          String(holderPid),
          "--",
          execOptions.bwrapPath,
          ...execOptions.bwrapArgs,
          "--",
          execOptions.shell,
          "-lc",
          execOptions.command,
        ],
        {
          cwd: execOptions.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: execOptions.env,
        },
      );

      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let timedOut = false;
        let settled = false;
        const timeoutHandle = execOptions.timeout
          ? setTimeout(() => {
              timedOut = true;
              killChild(child.pid);
            }, execOptions.timeout * 1000)
          : undefined;
        const onAbort = (): void => {
          killChild(child.pid);
        };

        child.stdout?.on("data", execOptions.onData);
        child.stderr?.on("data", execOptions.onData);
        execOptions.signal?.addEventListener("abort", onAbort, { once: true });

        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
        child.once("close", (exitCode) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          execOptions.signal?.removeEventListener("abort", onAbort);
          // 中断：reject signal.reason（默认是 name=AbortError 的 DOMException）
          if (execOptions.signal?.aborted) {
            reject(
              execOptions.signal.reason instanceof Error
                ? execOptions.signal.reason
                : new Error("The operation was aborted"),
            );
          } else if (timedOut) {
            // 超时：name=TimeoutError（对齐标准错误分类）
            reject(new TimeoutError(execOptions.timeout));
          } else resolve({ exitCode });
        });
      });
    },
    stop: async () => {
      killProcess(state.slirpPid);
      killProcess(state.holderPid);
      await rm(state.directory, { recursive: true, force: true }).catch(() => false);
    },
  };
  stackFinalizer.register(stack, state);
  return stack;
}
