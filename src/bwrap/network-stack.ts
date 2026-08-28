import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateSingboxConfig } from "./singbox-config.js";

export interface NetworkStackOptions {
  /** 允许直连的域名 / IP:port 列表（session 启动时固定，reload 才会重新加载）。 */
  readonly allowlist: readonly string[];
  /** 真实 DNS 服务器列表，按顺序 fallback。 */
  readonly dnsServers: readonly string[];
  readonly singBoxPath: string;
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
const HOLDER_PATH = fileURLToPath(new URL("holder.js", import.meta.url));
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

async function waitForFile(path: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for sandbox network stack to become ready");
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
 * 启动常驻的 per-session 网络栈：holder 进程持有 netns（内部跑 sing-box 的
 * TUN + fakeip + deny-by-default），slirp4netns 提供 egress。返回前
 * netns/sing-box/slirp4netns 均已就绪，命令通过 nsenter 进入该 netns 执行。
 */
export async function startNetworkStack(options: NetworkStackOptions): Promise<NetworkStack> {
  const { allowlist, dnsServers, singBoxPath, slirp4netnsPath } = options;
  const directory = await mkdtemp(join(tmpdir(), "pi-netns-"));
  const configPath = join(directory, "singbox.json");
  const readyFile = join(directory, "ready");
  await writeFile(configPath, generateSingboxConfig({ allowlist, dnsServers }));

  const holder = spawn(
    "unshare",
    ["-Urn", "--", "node", HOLDER_PATH, configPath, singBoxPath, readyFile],
    {
      env: {
        HOME: process.env.HOME ?? "",
        PATH: `${process.env.PATH ?? ""}:${SBIN_PATH_SUFFIX}`,
      },
      stdio: "ignore",
    },
  );
  if (holder.pid === undefined) {
    throw new Error("Failed to start network namespace holder");
  }
  const holderPid = holder.pid;
  await waitForNewUserns(holderPid);

  const slirp = spawn(
    slirp4netnsPath,
    [
      "-c",
      `--userns-path=/proc/${holderPid}/ns/user`,
      "--netns-type=pid",
      String(holderPid),
      "tap0",
    ],
    { stdio: "ignore" },
  );
  const slirpPid = slirp.pid;
  await waitForFile(readyFile);

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
          if (execOptions.signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${execOptions.timeout}`));
          else resolve({ exitCode });
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
