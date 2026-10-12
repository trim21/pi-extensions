/**
 * 原生沙箱执行器（`bin/native/<platform>-<arch>/sandbox`）的 TS 驱动层。
 *
 * 职责只有四件：定位二进制、序列化策略、spawn 并把输出转发给调用方、映射退出码与取消语义。
 * namespace 创建、网络栈生命周期、bwrap argv 构造与进程终止都在 Go 执行器里——TS 只描述"要什么能力"，
 * 这份能力描述就是 `SandboxPolicy`（与 native/policy.go 的 Policy 一一对应）。
 *
 * 调用契约（见 openspec/changes/wire-native-sandbox-executor/design.md）：
 *   - `<binary> run --policy-base64 <b64> [--verbose]`；
 *   - stdin 是控制通道：关掉它表示"请优雅停"，执行器读到 EOF 走内核级清理；
 *   - stdout = 命令 stdout；stderr = 命令 stderr + 带 `[netstack] ` 前缀的执行器诊断；
 *   - 退出码：命令码原样返回、124 超时、125 启动失败、2 用法/内部错误、信号 → 128+n。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { findExecutable, type NetworkMode, type SandboxMount } from "./core.js";

/** 执行器退出码语义，与 native/main.go 的常量一一对应。 */
export const EXIT_USAGE = 2;
export const EXIT_TIMEOUT = 124;
export const EXIT_STARTUP_FAILURE = 125;

/** mihomo TUN 与 slirp4netns tap0 共用的 MTU，两边不对齐时大包会在 slirp NAT 后 MTU blackhole。 */
export const MIHOMO_TUN_MTU = 1500;

/** 执行器诊断行的前缀（网络栈自身日志），与 native/main.go 的 netstackPrefix 一致。 */
const NETSTACK_PREFIX = "[netstack] ";

/** 取消时每一步的宽限：先关 stdin 让执行器自行退出，超时才 SIGTERM，最后 SIGKILL。 */
const STOP_GRACE_MS = 2000;

/** 启动失败时附进错误信息与落盘日志的执行器 stderr 尾部行数。 */
const STDERR_TAIL_LINES = 20;

/** 命令超时错误：name=TimeoutError（对齐标准错误分类），message 保留 timeout:N 格式。 */
export class TimeoutError extends Error {
  constructor(timeout: number | undefined) {
    super(`timeout:${timeout}`);
    this.name = "TimeoutError";
  }
}

/** 网络策略：`limited` 需要 allowlist 与上游 DNS，其余模式不建栈。 */
export interface SandboxNetworkPolicy {
  mode: NetworkMode;
  allowlist: string[];
  dnsServers: string[];
}

/** 一次执行的完整策略，字段与 native/policy.go 的 Policy 对应；路径 MUST 已是绝对路径。 */
export interface SandboxPolicy {
  root: string;
  mounts: SandboxMount[];
  extraArgs: string[];
  network: SandboxNetworkPolicy;
  mihomo: { path: string; mtu: number };
  slirp4netns: { path: string };
  bwrap: { path: string };
  command: string;
  shell: string;
  cwd: string;
  env: Record<string, string>;
  uid?: number;
  gid?: number;
  timeoutSeconds: number;
}

/** 二进制查找的可注入上下文，默认取当前进程；测试用它覆盖平台 / 架构 / 环境变量。 */
export interface SandboxBinaryContext {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
}

const ARCH_TARGETS: Partial<Record<string, string>> = {
  x64: "linux-x64",
  arm64: "linux-arm64",
};

/** 配置覆盖：开发期用 go build 的产物替代随包分发的二进制。 */
const BINARY_OVERRIDE_ENV = "PI_SANDBOX_BINARY";

/**
 * 定位随包分发的原生执行器；`PI_SANDBOX_BINARY` 存在时优先。
 *
 * 这里用同步的 fs 检查是有意的：`session_start` 的可用性判定（fail closed）是同步上下文，
 * 找不到二进制时 MUST 明确失败，不降级回已删除的 JS 实现。
 */
export function resolveSandboxBinary(context: SandboxBinaryContext = {}): string {
  const env = context.env ?? process.env;
  const platform = context.platform ?? process.platform;
  const arch = context.arch ?? process.arch;
  const override = env[BINARY_OVERRIDE_ENV];
  if (override !== undefined && override !== "") {
    assertExecutable(override, `${BINARY_OVERRIDE_ENV} points to a missing file: ${override}`);
    return override;
  }
  if (platform !== "linux") {
    throw new Error(
      `The native sandbox executor only supports Linux (current platform: ${platform}).`,
    );
  }
  const target = ARCH_TARGETS[arch];
  if (target === undefined) {
    throw new Error(`The native sandbox executor does not support the ${arch} architecture.`);
  }
  const path = fileURLToPath(new URL(`../../bin/native/${target}/sandbox`, import.meta.url));
  assertExecutable(
    path,
    `Native sandbox executor not found at ${path}. ` +
      `Run "pnpm run build:native" or point ${BINARY_OVERRIDE_ENV} at a built binary.`,
  );
  return path;
}

function assertExecutable(path: string, message: string): void {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(message);
  }
}

/** PATH 上解析 mihomo（配置覆盖优先），执行器不自行搜索 PATH。 */
export function resolveMihomoPath(override?: string): string {
  return findExecutable(
    "mihomo",
    "mihomo not found in PATH. Install it from https://github.com/MetaCubeX/mihomo",
    override,
  );
}

/** PATH 上解析 slirp4netns（配置覆盖优先）。 */
export function resolveSlirp4netnsPath(override?: string): string {
  return findExecutable(
    "slirp4netns",
    "slirp4netns not found in PATH. Install it from https://github.com/rootless-containers/slirp4netns",
    override,
  );
}

const NAMESERVER_PATTERN = /^\s*nameserver\s+(\S+)/;

/** egress 通道自带的解析器（slirp4netns 的内置 DNS）：它在宿主侧解析。 */
export const SLIRP_DNS = "10.0.2.3";

/** systemd-resolved 维护的真实上游列表：宿主 `/etc/resolv.conf` 只是 loopback stub 时用这个。 */
const RESOLVED_UPSTREAM = "/run/systemd/resolve/resolv.conf";

function parseNameservers(content: string): string[] {
  return content
    .split("\n")
    .map((line) => NAMESERVER_PATTERN.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

async function readNameservers(path: string): Promise<string[]> {
  try {
    return parseNameservers(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * 挑出能当网络栈上游的地址。
 *
 * 两个排除条件：必须是 IPv4（egress 通道只提供 IPv4）；不能是 loopback——在沙箱内 loopback
 * 指向网络栈自身（本机 53 上就是我们的监听），拿它当上游只会把域名解析回网络栈分配的地址
 * 形成回环。宿主用 systemd-resolved stub（`127.0.0.53`）时，`/etc/resolv.conf` 整份都会被排除。
 */
export function routableDnsServers(nameservers: readonly string[]): string[] {
  return nameservers.filter((value) => !value.includes(":") && !isLoopback(value));
}

function isLoopback(address: string): boolean {
  return address === "localhost" || address.startsWith("127.");
}

/**
 * 网络栈的上游 DNS：宿主 `resolv.conf` 里可路由的地址优先；只剩 loopback stub 时用
 * systemd-resolved 维护的真实上游；都拿不到才回退 egress 通道自带的解析器（宿主侧解析）。
 */
export async function resolveDnsServers(): Promise<string[]> {
  const routable = routableDnsServers(await readNameservers("/etc/resolv.conf"));
  if (routable.length > 0) {
    return routable;
  }
  const resolved = routableDnsServers(await readNameservers(RESOLVED_UPSTREAM));
  return resolved.length > 0 ? resolved : [SLIRP_DNS];
}

/**
 * 执行器启动失败或运行期异常退出时，把已收集的诊断与错误落盘到 agent-dir/tmp，
 * 返回日志路径；写入失败（目录不可写）静默返回 undefined，不掩盖原错误。
 */
async function writeFailureLog(
  error: unknown,
  stderrLines: readonly string[],
): Promise<string | undefined> {
  const content = [
    `# ${new Date().toISOString()}`,
    "",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
    "",
    "## executor stderr",
    stderrLines.length > 0 ? stderrLines.join("\n") : "(no output captured)",
    "",
  ].join("\n");
  const dir = join(getAgentDir(), "tmp");
  const path = join(dir, `bwrap-sandbox-${randomUUID()}.log`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, content);
    return path;
  } catch {
    return undefined;
  }
}

export interface ExecutorRunOptions {
  /** 命令输出（stdout 与命令 stderr 已合并）。 */
  onData: (data: Buffer) => void;
  /** 取消执行：先关 stdin，短暂等待后 SIGTERM，最后 SIGKILL。 */
  signal?: AbortSignal;
  /** 执行器自身诊断（`[netstack] ` 前缀行，去掉前缀）；提供时才给执行器加 `--verbose`。 */
  onDiagnostic?: (line: string) => void;
}

export interface ExecutorResult {
  /** 命令退出码（执行器把信号死亡折算成 128+n）。 */
  exitCode: number;
}

interface ExecutorOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * 执行一次策略。返回命令退出码；启动失败（125）、内部错误（2）、被信号杀死或超时
 * 分别以对应的错误结束（超时 → TimeoutError，其余附执行器 stderr 尾部与落盘诊断路径）。
 */
export async function runSandboxExecutor(
  policy: SandboxPolicy,
  options: ExecutorRunOptions,
): Promise<ExecutorResult> {
  const binary = resolveSandboxBinary();
  const encoded = Buffer.from(JSON.stringify(policy)).toString("base64");
  const args = ["run", "--policy-base64", encoded];
  if (options.onDiagnostic !== undefined) {
    args.push("--verbose");
  }
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });

  const stderrLines: string[] = [];
  let aborted = options.signal?.aborted === true;
  let stopPromise: Promise<void> | undefined;
  const requestStop = (): void => {
    aborted = true;
    stopPromise ??= stopExecutor(child);
  };
  const onAbort = (): void => requestStop();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  // stderr 逐行分流：`[netstack] ` 前缀是执行器诊断，其余是命令 stderr。
  // 执行器自身就按行转发命令 stderr（native/main.go 用 bufio.Scanner 逐行处理），这里按行分流不引入额外缓冲。
  const lines = createInterface({ input: child.stderr, crlfDelay: Infinity });
  const diagnosticEnabled = options.onDiagnostic !== undefined;
  lines.on("line", (line) => {
    stderrLines.push(line);
    // 只有加了 `--verbose`（提供 onDiagnostic）时执行器才打印 `[netstack] ` 诊断行；
    // 否则按行原样转发，免得命令自己的 stderr 里同前缀的内容被误吞
    if (diagnosticEnabled && line.startsWith(NETSTACK_PREFIX)) {
      options.onDiagnostic?.(line.slice(NETSTACK_PREFIX.length));
      return;
    }
    options.onData(Buffer.from(`${line}\n`));
  });
  child.stdout.on("data", options.onData);

  if (aborted) {
    requestStop();
  }

  let outcome: ExecutorOutcome;
  try {
    outcome = await new Promise<ExecutorOutcome>((resolve, reject) => {
      let settled = false;
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ exitCode, signal });
      });
    });
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // 取消路径的 stopExecutor 可能仍在 SIGTERM/SIGKILL 之间，等它收官再返回
    await stopPromise;
  }

  if (aborted) {
    const reason: unknown = options.signal?.reason;
    throw reason instanceof Error ? reason : new Error("The operation was aborted");
  }
  if (outcome.exitCode === EXIT_TIMEOUT) {
    throw new TimeoutError(policy.timeoutSeconds);
  }
  if (
    outcome.exitCode !== null &&
    outcome.exitCode !== EXIT_STARTUP_FAILURE &&
    outcome.exitCode !== EXIT_USAGE
  ) {
    return { exitCode: outcome.exitCode };
  }
  // 执行器在命令结束前退出（启动失败 / 内部错误 / 被信号杀死）：落盘诊断并把路径附进错误
  throw await executorFailure(outcome, stderrLines);
}

/** 把执行器的异常退出折算成带 stderr 尾部与诊断日志路径的错误。 */
async function executorFailure(
  outcome: ExecutorOutcome,
  stderrLines: readonly string[],
): Promise<Error> {
  const reason =
    outcome.exitCode === EXIT_STARTUP_FAILURE
      ? "Sandbox failed to start (executor exit code 125)"
      : outcome.exitCode === EXIT_USAGE
        ? "Sandbox executor reported an internal error (exit code 2)"
        : `Sandbox executor exited before the command finished (signal ${outcome.signal ?? "unknown"})`;
  const detail = stderrLines.slice(-STDERR_TAIL_LINES).join("\n");
  const error = new Error(detail === "" ? reason : `${reason}:\n${detail}`);
  const logPath = await writeFailureLog(error, stderrLines);
  return logPath === undefined
    ? error
    : new Error(`${error.message}\n(sandbox diagnostics: ${logPath})`, { cause: error });
}

/**
 * 停止执行器：先关 stdin（执行器读到 EOF 走内核级清理），到点再 SIGTERM，最后 SIGKILL。
 *
 * 为什么可以按 pid 发信号：它是本进程自己 spawn 的子进程，检查与发信号之间的 pid 复用窗口
 * 与改动前同级；真正的清理（pid namespace 内的进程）由执行器与内核完成，不依赖这里的信号。
 */
async function stopExecutor(child: ChildProcess): Promise<void> {
  child.stdin?.end();
  if (await waitForExit(child)) {
    return;
  }
  child.kill("SIGTERM");
  if (await waitForExit(child)) {
    return;
  }
  child.kill("SIGKILL");
}

/** 等待子进程退出（最长 STOP_GRACE_MS）；到点返回 false，不抛错。 */
function waitForExit(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, STOP_GRACE_MS);
    child.once("exit", onExit);
  });
}
