import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { forEachLine } from "../lib/proc.js";
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

function killProcess(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) return;
  try {
    process.kill(pid, signal);
  } catch {
    // 已退出
  }
}

/** 轮询等待进程退出（进程消失即返回）。 */
async function waitForExit(pid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 读取进程的直接子进程 pid：--kill-child 只转发信号给 fork 的子进程，兜底直接 SIGKILL 用。 */
async function readChildPids(pid: number): Promise<number[]> {
  try {
    const content = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return content.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
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

/** 等待目标进程进入新的 user namespace（unshare 完成），返回后命令才能 nsenter 进入。 */
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
    const onReady = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // 按行扫描：mihomo 日志行可能跨 data chunk，由 forEachLine 负责拼接
    for (const stream of [holder.stdout, holder.stderr]) {
      if (stream) {
        // 不提前停止：holder 生命周期内持续消费输出，避免流无消费者触发背压
        void forEachLine(stream, (line) => {
          if (line.includes("Tun adapter listening")) onReady();
        }).catch(() => {
          // 就绪判定由超时与 holder exit 兜底，流的 error 忽略
        });
      }
    }
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
}

interface NetworkStackState {
  holderPid: number;
  slirpPid: number;
}

/** 兜底：调用方忘记 stop() 时，对象被 GC 回收后 kill 残留进程。 */
const stackFinalizer = new FinalizationRegistry<NetworkStackState>((state) => {
  // SIGTERM 经 unshare --kill-child 转发给 init，内核清理 pid ns 内全部进程；
  // slirp4netns 在宿主侧持有 tap fd，单独终止
  killProcess(state.holderPid);
  killProcess(state.slirpPid);
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
  } = options;
  // mihomo 支持 -config 直接接收 base64 配置，无需写配置文件中转
  const config = generateMihomoConfig({ allowlist, dnsServers });
  const configBase64 = Buffer.from(JSON.stringify(config)).toString("base64");

  // mihomo 工作目录（-d）：cache.db 等落在这里，而不是它默认的 ~/.config/mihomo/
  //（后者不存在时 mihomo 每次启动都告警且 fakeip 映射无持久化）。每次启动用独立
  // uuid 目录，避免并发的多个 holder 争抢 bbolt 文件锁。
  const mihomoHome = join(getAgentDir(), "tmp", `mihomo-${randomUUID()}`);
  await mkdir(mihomoHome, { recursive: true });

  let holder: ChildProcess | undefined;
  let slirp: ChildProcess | undefined;
  try {
    // unshare -p --fork：node 成为 pid namespace 的 init，任何方式退出（含 SIGKILL）
    // 内核都会清理 pid ns 内全部进程（mihomo），ns 引用随之归零；
    // --kill-child=SIGTERM：宿主侧 SIGTERM unshare 时转发给 init 走优雅退出
    holder = spawn(
      "unshare",
      [
        "-Urnp",
        "--fork",
        "--kill-child=SIGTERM",
        "--",
        "node",
        HOLDER_PATH,
        configBase64,
        mihomoPath,
        String(TUN_MTU),
        mihomoHome,
      ],
      {
        env: {
          HOME: process.env.HOME ?? "",
          PATH: `${process.env.PATH ?? ""}:${SBIN_PATH_SUFFIX}`,
        },
        // stdin 保持 pipe：本进程持有写端，进程退出（含 SIGKILL）时内核关闭 fd，
        // holder 读到 EOF 即自杀（init 退出 → 内核清理 pid ns）。
        // fd 3：exit-fd 写端，传给 holder 持有（holder 死亡 → 读端 HUP → slirp4netns 退出）。
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
    forwardOutput(holder, holderOutput);
    if (holder.pid === undefined) {
      throw new Error("Failed to start network namespace holder");
    }
    const holderPid = holder.pid;
    await waitForNewUserns(holderPid);

    // slirp4netns 提供 egress，必须在宿主 netns 启动：它的 egress socket 决定出站
    // 视角，留在沙盒 netns 里会被 mihomo 的 TUN 策略路由 + dns-hijack 自劫持成环
    //（上游 DNS 查询自己劫自己，allowlist 域名全部 SERVFAIL）。tap fd 会被它持有
    // 而 pin 住 netns，因此用 exit-fd（holder 的 fd 3 写端的读端）绑定 holder 生命
    // 周期：holder 退出 → 读端 HUP → slirp4netns 退出 → tap fd 释放。
    // --userns-path / --netns-type=pid 都指向 unshare 进程：它创建并持有目标
    // userns/netns（node holder 是它的子进程，同 ns）。
    // exit-fd 的读端 fd：从 holder 的额外 stdio pipe 取父进程侧的原始 fd。
    // Node 没有公开 API 拿它（stdio[3].fd 恒为 undefined，只能读 _handle，且仅在
    // 子进程存活期间有效）；pipe 要跨两个子进程共享（holder 持写端、slirp4netns
    // 持读端），所以必须把父进程侧的 fd 重新 dup 给 slirp4netns。
    const exitReadFd = (holder.stdio[3] as unknown as { _handle?: { fd?: number } } | null)?._handle
      ?.fd;
    if (typeof exitReadFd !== "number") {
      throw new TypeError("Failed to resolve exit-fd from holder stdio");
    }
    slirp = spawn(
      slirp4netnsPath,
      [
        "-c",
        `--mtu=${TUN_MTU}`,
        `--userns-path=/proc/${String(holderPid)}/ns/user`,
        "--netns-type=pid",
        String(holderPid),
        "tap0",
        // exit-fd：本子进程的 fd 3（stdio 第 4 项 dup 为 fd 3）
        "-e",
        "3",
      ],
      { stdio: ["ignore", "pipe", "pipe", exitReadFd] },
    );
    forwardOutput(slirp, holderOutput);
    if (slirp.pid === undefined) {
      throw new Error("Failed to start slirp4netns");
    }

    await waitForMihomoStarted(holder);

    const state: NetworkStackState = { holderPid, slirpPid: slirp.pid };
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
        const children = await readChildPids(state.holderPid);
        // slirp4netns 持有 tap fd（pin 住 netns），必须随 holder 一起显式终止；
        // 先杀它再杀 holder，避免 stop() 与 exit-fd HUP 的收尾时序竞争
        killProcess(state.slirpPid);
        // SIGTERM unshare → --kill-child 转发 SIGTERM 给 init（pid ns 的 pid 1），
        // init 优雅停 mihomo 后退出，内核清理 pid ns 内全部进程，ns 引用随之归零
        killProcess(state.holderPid);
        await waitForExit(state.holderPid);
        await waitForExit(state.slirpPid);
        // 兜底：init 未在超时内退出 → SIGKILL init → 内核清 pid ns
        for (const pid of children) {
          killProcess(pid, "SIGKILL");
        }
      },
      holderPid,
    };
    stackFinalizer.register(stack, state);
    return stack;
  } catch (error) {
    // 失败清理：holder（unshare）的 SIGTERM 经 --kill-child 转发给 init，
    // init 退出时内核清理 pid ns 内全部进程；slirp4netns 在宿主侧，需单独终止
    //（exit-fd 写端也会随 holder 死亡关闭，这里主动杀只是不等到 HUP 轮询）
    if (slirp?.pid) {
      killProcess(slirp.pid);
    }
    if (holder?.pid) {
      const children = await readChildPids(holder.pid);
      killProcess(holder.pid);
      await waitForExit(holder.pid);
      for (const pid of children) {
        killProcess(pid, "SIGKILL");
      }
    }
    throw error;
  }
}
