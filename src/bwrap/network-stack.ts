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
  /**
   * holder（unshare + mihomo）输出透传。默认只用于就绪探测、内容丢弃，
   * 因此启动失败时只剩 "exited before mihomo started"，诊断需要它。
   */
  readonly onHolderOutput?: (chunk: string) => void;
  /** slirp4netns 输出透传；不传时其 stdio 保持 ignore。 */
  readonly onSlirpOutput?: (chunk: string) => void;
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
// 构建产物 holder.js（esbuild 编译）：node 对 node_modules 下的 .ts 拒绝 type stripping，
// 扩展从 npm 包加载时 holder.ts 落在 node_modules 下，直接运行会 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
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

/**
 * SIGTERM 后等待进程退出；超时仍未退出则 SIGKILL。
 * holder/slirp 持有 userns/netns 引用，进程不退 ns 就不会释放。
 */
async function terminateProcess(pid: number | undefined, timeoutMs = 2000): Promise<void> {
  if (!pid) return;
  killProcess(pid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
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

/**
 * 额外转发子进程输出给诊断回调（就绪探测的监听器不受影响）。
 * 注册 error 监听器后 spawn 失败（如 unshare 缺失）不再以未捕获异常结束进程。
 */
function forwardOutput(child: ChildProcess, onOutput: ((chunk: string) => void) | undefined): void {
  if (!onOutput) return;
  const write = (chunk: Buffer): void => onOutput(chunk.toString());
  child.stdout?.on("data", write);
  child.stderr?.on("data", write);
  child.once("error", (error) => onOutput(String(error)));
}

export interface NetworkStack {
  exec(options: NetworkStackExecOptions): Promise<{ exitCode: number | null }>;
  stop(): Promise<void>;
  /** holder pid：可 `nsenter -U -n --preserve-credentials -t <pid>` 手动进入该 netns 排查。 */
  readonly holderPid: number;
  /** 生成的 mihomo 配置路径（stop() 后随临时目录一起删除）。 */
  readonly configPath: string;
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
  const {
    allowlist,
    dnsServers,
    mihomoPath,
    slirp4netnsPath,
    onHolderOutput: holderOutput,
    onSlirpOutput: slirpOutput,
  } = options;
  const directory = await mkdtemp(join(tmpdir(), "pi-netns-"));
  const configPath = join(directory, "mihomo.json");
  const config = generateMihomoConfig({ allowlist, dnsServers });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  let holder: ChildProcess | undefined;
  let slirp: ChildProcess | undefined;
  try {
    holder = spawn("unshare", ["-Urn", "--", "node", HOLDER_PATH, configPath, mihomoPath], {
      env: {
        HOME: process.env.HOME ?? "",
        PATH: `${process.env.PATH ?? ""}:${SBIN_PATH_SUFFIX}`,
      },
      // mihomo 日志经 holder 透传到这里的 stdout/stderr，用于判定就绪
      stdio: ["ignore", "pipe", "pipe"],
    });
    forwardOutput(holder, holderOutput);
    if (holder.pid === undefined) {
      throw new Error("Failed to start network namespace holder");
    }
    const holderPid = holder.pid;
    await waitForNewUserns(holderPid);

    slirp = spawn(
      slirp4netnsPath,
      [
        "-c",
        `--mtu=${TUN_MTU}`,
        `--userns-path=/proc/${holderPid}/ns/user`,
        "--netns-type=pid",
        String(holderPid),
        "tap0",
      ],
      // 默认丢弃 slirp4netns 日志；诊断时改为管道转发
      { stdio: slirpOutput ? ["ignore", "pipe", "pipe"] : "ignore" },
    );
    forwardOutput(slirp, slirpOutput);
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
        await terminateProcess(state.slirpPid);
        await terminateProcess(state.holderPid);
        await rm(state.directory, { recursive: true, force: true }).catch(() => false);
      },
      holderPid,
      configPath,
    };
    stackFinalizer.register(stack, state);
    return stack;
  } catch (error) {
    // 失败清理：holder/slirp 持有 userns/netns 引用，不 kill 就会锁住 namespace；
    // 调用方（runInSandbox）拿不到 stack，这里的清理只能靠自己
    if (slirp?.pid) await terminateProcess(slirp.pid);
    if (holder?.pid) await terminateProcess(holder.pid);
    await rm(directory, { recursive: true, force: true }).catch(() => false);
    throw error;
  }
}
