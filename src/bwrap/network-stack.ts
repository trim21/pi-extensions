import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { forEachLine } from "../lib/proc.js";
import { generateMihomoConfig, TUN_MTU } from "./mihomo-config.js";

export interface NetworkStackOptions {
  /** 允许直连的域名 / IP:port 列表（每次命令从配置重新读取）。 */
  readonly allowlist: readonly string[];
  /** 真实 DNS 服务器列表，按顺序 fallback。 */
  readonly dnsServers: readonly string[];
  readonly mihomoPath: string;
  readonly slirp4netnsPath: string;
  /**
   * holder（unshare + mihomo）输出透传。输出同时始终写入诊断缓冲，启动
   * 失败时落盘到 agent-dir/tmp 并把路径附进错误信息，没有它也能拿到死因。
   */
  readonly onHolderOutput?: (chunk: string) => void;
}

const NAMESERVER_PATTERN = /^\s*nameserver\s+(\S+)/;

/**
 * 启动失败时把收集到的子进程完整 stdout/stderr 与错误本身落盘到
 * agent-dir/tmp，返回日志路径；写入失败（如目录不可写）静默返回 undefined，
 * 不掩盖原错误。日志不进工具结果文本：holder 输出可能很长且与命令无关，
 * 只回路径。
 */
async function writeFailureLog(
  error: unknown,
  logs: readonly string[],
): Promise<string | undefined> {
  const sections = logs.map(
    (log, index) => `## child ${index}\n${log.length > 0 ? log : "(no output captured)"}`,
  );
  const content = [
    `# ${new Date().toISOString()}`,
    "",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
    "",
    ...sections,
    "",
  ].join("\n");
  const dir = join(getAgentDir(), "tmp");
  const path = join(dir, `bwrap-netstack-${randomUUID()}.log`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, content);
    return path;
  } catch {
    return undefined;
  }
}
// 构建产物 holder.js（esbuild 编译）：node 对 node_modules 下的 .ts 拒绝 type stripping，
// 扩展从 npm 包加载时 holder.ts 落在 node_modules 下，直接运行会 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
const HOLDER_PATH = fileURLToPath(new URL("holder.js", import.meta.url));
// ip 通常位于 /usr/sbin 或 /sbin，进程默认 PATH 不含它们；node 则依赖宿主完整 PATH
const SBIN_PATH_SUFFIX = "/usr/local/sbin:/usr/sbin:/sbin";

function killProcess(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // 已退出
  }
}

/**
 * 终止 holder（unshare 包装进程）必须用 SIGKILL：util-linux 的 unshare 在 fork 前
 * `sigprocmask(SIG_BLOCK, {SIGINT, SIGTERM})`，且只在子进程里恢复掩码——父进程永久
 * 阻塞这两个信号，发给它的 SIGTERM 只会 pending 永不投递（实测 3s 后仍存活）。
 * SIGKILL 不可阻塞，unshare 立即退出；其子进程（pid ns 的 init）经 --kill-child 的
 * PDEATHSIG 收到 SIGTERM，走优雅退出并触发内核清理整个 pid ns。
 */
function killHolder(pid: number | undefined): void {
  killProcess(pid, "SIGKILL");
}

/** 轮询等待进程退出（进程消失即返回）。 */
async function waitForExit(pid: number): Promise<void> {
  const timeoutMs = 2000;
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

/** 读取 holder 的直接子进程 pid（pid ns 的 init）：PDEATHSIG 未生效时的 SIGKILL 兜底用。 */
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
      if ((await readlink(`/proc/${pid}/ns/user`)) !== self) {
        return;
      }
    } catch {
      // /proc/<pid> 尚未就绪，重试
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for sandbox network namespace");
}

/**
 * 监听 holder 的 stdout/stderr（mihomo 日志透传），以 "Tun adapter listening" 作为就绪标志。
 * holder 提前退出的情形由 startNetworkStack 统一注册的 exit 监听兜底。
 */
function waitForMihomoStarted(holder: ChildProcess, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error("Timed out waiting for mihomo to start"));
    }, timeoutMs);
    const onReady = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // 按行扫描：mihomo 日志行可能跨 data chunk，由 forEachLine 负责拼接
    for (const stream of [holder.stdout, holder.stderr]) {
      if (stream) {
        // 不提前停止：holder 生命周期内持续消费输出，避免流无消费者触发背压
        void forEachLine(stream, (line) => {
          if (line.includes("Tun adapter listening")) {
            onReady();
          }
        }).catch(() => {
          // 就绪判定由超时与 holder exit 兜底，流的 error 忽略
        });
      }
    }
  });
}

/**
 * 额外转发子进程输出给诊断回调（就绪探测的监听器不受影响），并把全部输出
 * 收进 collect：启动失败时落盘，否则没有别的渠道能看到 holder 的真实死因。
 * 注册 error 监听器后 spawn 失败（如 unshare 缺失）不再以未捕获异常结束进程。
 */
function forwardOutput(
  child: ChildProcess,
  onOutput: ((chunk: string) => void) | undefined,
  collect: string[],
): void {
  const write = (chunk: Buffer): void => {
    const text = chunk.toString();
    collect.push(text);
    onOutput?.(text);
  };
  child.stdout?.on("data", write);
  child.stderr?.on("data", write);
  child.once("error", (error) => {
    collect.push(String(error));
    onOutput?.(String(error));
  });
}

export interface NetworkStack {
  stop(): Promise<void>;
  /** holder pid：可 `nsenter -U -n --preserve-credentials -t <pid>` 手动进入该 netns 排查。 */
  readonly holderPid: number;
}

interface NetworkStackState {
  holderPid: number;
  slirpPid: number;
  /** 过滤进程的工作目录：GC 兜底路径也要把它删掉。 */
  mihomoHome: string;
}

/** 兜底：调用方忘记 stop() 时，对象被 GC 回收后 kill 残留进程并清掉工作目录。 */
const stackFinalizer = new FinalizationRegistry<NetworkStackState>((state) => {
  // holder 退出触发内核清理 pid ns 内全部进程；
  // slirp4netns 在宿主侧持有 tap fd，单独终止
  killHolder(state.holderPid);
  killProcess(state.slirpPid);
  // FinalizationRegistry 回调不能 await：尽力而为，删不掉就留下（宿主崩溃时同样如此）
  // eslint-disable-next-line unicorn/no-useless-undefined
  void rm(state.mihomoHome, { recursive: true, force: true }).catch(() => undefined);
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
  // uuid 目录，避免并发的多个 holder 争抢 bbolt 文件锁；正常停栈与 GC 兜底删除该
  // 目录（见 stop / stackFinalizer），启动失败时保留作诊断材料（见 catch）。
  const mihomoHome = join(getAgentDir(), "tmp", `mihomo-${randomUUID()}`);
  await mkdir(mihomoHome, { recursive: true });

  let holder: ChildProcess | undefined;
  let slirp: ChildProcess | undefined;
  const holderLog: string[] = [];
  const slirpLog: string[] = [];
  try {
    // unshare -p --fork：node 成为 pid namespace 的 init，任何方式退出（含 SIGKILL）
    // 内核都会清理 pid ns 内全部进程（mihomo），ns 引用随之归零；
    // --kill-child=SIGTERM：init 拿到 PR_SET_PDEATHSIG，unshare 死亡时收到 SIGTERM
    // 走优雅退出（注意 unshare 自身阻塞 SIGINT/SIGTERM，终止它只能靠 SIGKILL，见 killHolder）
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
    forwardOutput(holder, holderOutput, holderLog);
    let holderPid = holder.pid;
    if (holderPid === undefined) {
      // spawn 失败（如 unshare 缺失）：error 事件异步到达，等一拍让它落进诊断缓冲
      await new Promise((resolve) => setImmediate(resolve));
      holderPid = holder.pid;
      if (holderPid === undefined) {
        throw new Error("Failed to start network namespace holder");
      }
    }
    // holder 提前退出是启动失败最常见的形态（unshare 被拒、node 崩溃、mihomo 起
    // 不来）：立即注册 exit 监听并参与后续所有等待的 race，避免「进程秒死却被
    // 呈现为 5s/20s 超时」。stop() 正常杀 holder 也走这里，下方 catch 防
    // unhandled rejection。
    const { promise: holderExited, reject: rejectHolderExited } = Promise.withResolvers<never>();
    holder.once("exit", (code) => {
      rejectHolderExited(new Error(`Sandbox holder exited before mihomo started (code ${code})`));
    });
    // stop() 正常终止 holder 也会 reject：吞掉，防 unhandled rejection
    // eslint-disable-next-line unicorn/no-useless-undefined
    holderExited.catch(() => undefined);
    // race 输掉的 promise 之后仍可能迟到 reject（如 userns 轮询到点才超时），
    // 补 no-op catch 防止 unhandled rejection 让进程崩溃
    const usernsReady = waitForNewUserns(holderPid);
    await Promise.race([usernsReady, holderExited]).finally(() => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      usernsReady.catch(() => undefined);
    });

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
    const exitReadFd = (holder.stdio[3] as { _handle?: { fd?: number } } | null)?._handle?.fd;
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
    forwardOutput(slirp, holderOutput, slirpLog);
    if (slirp.pid === undefined) {
      throw new Error("Failed to start slirp4netns");
    }

    const mihomoReady = waitForMihomoStarted(holder);
    await Promise.race([mihomoReady, holderExited]).finally(() => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      mihomoReady.catch(() => undefined);
    });

    const state: NetworkStackState = { holderPid, slirpPid: slirp.pid, mihomoHome };
    const stack: NetworkStack = {
      stop: async () => {
        const children = await readChildPids(state.holderPid);
        // slirp4netns 持有 tap fd（pin 住 netns），必须随 holder 一起显式终止；
        // 先杀它再杀 holder，避免 stop() 与 exit-fd HUP 的收尾时序竞争
        killProcess(state.slirpPid);
        // SIGKILL holder → init 经 PDEATHSIG 收到 SIGTERM，优雅停 mihomo 后退出，
        // 内核清理 pid ns 内全部进程，ns 引用随之归零（毫秒级，见 killHolder）
        killHolder(state.holderPid);
        await waitForExit(state.holderPid);
        await waitForExit(state.slirpPid);
        // 兜底：init 未在超时内退出 → SIGKILL init → 内核清 pid ns
        for (const pid of children) {
          killProcess(pid, "SIGKILL");
        }
        // 工作目录只服务本次实例（mihomo 的 cache.db 等运行时缓存），随停栈删除；
        // best-effort：删除失败不外抛，避免掩盖命令结果
        // eslint-disable-next-line unicorn/no-useless-undefined
        await rm(state.mihomoHome, { recursive: true, force: true }).catch(() => undefined);
      },
      holderPid,
    };
    stackFinalizer.register(stack, state);
    return stack;
  } catch (error) {
    // 失败清理：SIGKILL holder（unshare）→ init 经 PDEATHSIG 收到 SIGTERM 后退出，
    // 内核清理 pid ns 内全部进程；slirp4netns 在宿主侧，需单独终止
    //（exit-fd 写端也会随 holder 死亡关闭，这里主动杀只是不等到 HUP 轮询）
    if (slirp?.pid) {
      killProcess(slirp.pid);
    }
    if (holder?.pid) {
      const children = await readChildPids(holder.pid);
      killHolder(holder.pid);
      await waitForExit(holder.pid);
      for (const pid of children) {
        killProcess(pid, "SIGKILL");
      }
    }
    // 这里刻意不删 mihomoHome：启动失败时它属于现场材料，与下面落盘的诊断日志
    //（holder / slirp 输出 + 错误本身）配套保留，便于事后排查；失败路径罕见，
    // 留一个目录不构成泄漏
    const logPath = await writeFailureLog(error, [holderLog.join(""), slirpLog.join("")]);
    if (logPath !== undefined && error instanceof Error) {
      throw new Error(`${error.message}\n(sandbox startup diagnostics: ${logPath})`, {
        cause: error,
      });
    }
    throw error;
  }
}
