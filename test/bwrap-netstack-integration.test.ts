import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  completeBwrapConfig,
  findMihomo,
  findSlirp4netns,
  resolveBwrap,
} from "../src/bwrap/core.js";
import { buildBwrapInvocation, execInvocation, invocationArgv } from "../src/bwrap/exec.js";
import {
  type NetworkStack,
  resolveDnsServers,
  startNetworkStack,
} from "../src/bwrap/network-stack.js";

/** 命令的执行目录：也是 invocation 里 "." 可写路径的解析基准。 */
const WORKSPACE = "/tmp";

// 调用用生产路径组装（argv 与干净环境由 buildBwrapInvocation 给出），不再手抄 bwrap argv。
const strategy = resolveBwrap(
  completeBwrapConfig({ fs: { mode: "workspace-write" }, network: { mode: "limited" } }),
);

async function pidExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pidExists(pid))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** 网络栈在 agent tmp 目录下创建的 mihomo 工作目录（一次启动一个）。 */
async function mihomoWorkDirs(): Promise<string[]> {
  const entries = await readdir(join(getAgentDir(), "tmp"));
  return entries.filter((name) => name.startsWith("mihomo-")).toSorted();
}

/** 在既有栈里跑一条命令并收集输出（栈由调用方启动与停止）。 */
async function execInStack(stack: NetworkStack, command: string): Promise<string> {
  let out = "";
  const invocation = await buildBwrapInvocation(strategy, WORKSPACE, command);
  await execInvocation(invocation, {
    cwd: WORKSPACE,
    holderPid: stack.holderPid,
    onData: (data: Buffer) => {
      out += data.toString();
    },
  });
  return out;
}

/** 起一个栈跑一条命令并收集输出（栈随命令结束停止）。 */
async function runInStack(
  allowlist: string[],
  command: string,
  dnsServers: string[],
): Promise<string> {
  const stack = await startNetworkStack({
    allowlist,
    dnsServers,
    mihomoPath: findMihomo(),
    slirp4netnsPath: findSlirp4netns(),
  });
  try {
    return (await execInStack(stack, command)).trim();
  } finally {
    await stack.stop();
  }
}

// 需要真实 mihomo/slirp4netns/unshare 与可出网的 DNS，常规 CI 不满足；
// 手动用 RUN_NETSTACK_INTEGRATION=1 运行。某些环境的系统 DNS 走 slirp4netns
// 出站不可达时，可用 NETSTACK_DNS 指定一个可通的 DNS（如 NETSTACK_DNS=223.5.5.5）。
describe.skipIf(process.env.RUN_NETSTACK_INTEGRATION !== "1")("NetworkStack integration", () => {
  // 回归：条目匹配精度两档——裸域名只匹配自己，`*.` 前缀匹配全部子域名（不含 apex）。
  it("matches bare domains exactly and '*.domain' entries as subdomains only", async () => {
    const dnsServers = process.env.NETSTACK_DNS
      ? [process.env.NETSTACK_DNS]
      : await resolveDnsServers();
    const resolve = (allowlist: string[], host: string): Promise<string> =>
      runInStack(allowlist, `getent ahostsv4 ${host} | head -1`, dnsServers);

    // 精确条目：apex 拿到 fake IP，子域名被拒（解析失败）
    expect(await resolve(["pypi.org"], "pypi.org")).toMatch(/^198\.18\./);
    expect(await resolve(["pypi.org"], "a.b.pypi.org")).toBe("");

    // 通配条目：任意深度子域名拿到 fake IP，apex 与同后缀域名被拒
    expect(await resolve(["*.pypi.org"], "a.b.pypi.org")).toMatch(/^198\.18\./);
    expect(await resolve(["*.pypi.org"], "pypi.org")).toBe("");
    expect(await resolve(["*.pypi.org"], "notpypi.org")).toBe("");

    // 连接层与 DNS 层一致：通配条目的子域名能真的连出去
    const httpCode = await runInStack(
      ["*.pythonhosted.org"],
      'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://files.pythonhosted.org/',
      dnsServers,
    );
    expect(httpCode).toMatch(/^[1-5]\d\d$/);
  }, 120000);

  // 回归：每次启动的 mihomo 工作目录必须在停栈时删除（曾只 mkdir 从不删，
  // 实测本机累积 10026 个目录 / 196MB）。
  it("removes the mihomo work dir when the stack stops", async () => {
    const before = await mihomoWorkDirs();
    const stack = await startNetworkStack({
      allowlist: [],
      dnsServers: await resolveDnsServers(),
      mihomoPath: findMihomo(),
      slirp4netnsPath: findSlirp4netns(),
    });
    expect(await mihomoWorkDirs()).toHaveLength(before.length + 1);
    await stack.stop();
    expect(await mihomoWorkDirs()).toEqual(before);
  }, 60000);

  // 回归：holder（unshare）永久阻塞 SIGINT/SIGTERM，用 SIGTERM 停它会走满
  // waitForExit 的 2000ms 固定超时（实测每条命令 ~2.09s）。停止必须是毫秒级。
  it("stops within a second and leaves no holder process", async () => {
    const dnsServers = process.env.NETSTACK_DNS
      ? [process.env.NETSTACK_DNS]
      : await resolveDnsServers();
    const stack = await startNetworkStack({
      allowlist: [],
      dnsServers,
      mihomoPath: findMihomo(),
      slirp4netnsPath: findSlirp4netns(),
    });
    const holderPid = stack.holderPid;
    const startedAt = Date.now();
    await stack.stop();
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1000);
    expect(await waitForPidGone(holderPid, 1000)).toBe(true);
  }, 60000);

  it("allowlist domain resolves, non-allowlist is blocked", async () => {
    const dnsServers = process.env.NETSTACK_DNS
      ? [process.env.NETSTACK_DNS]
      : await resolveDnsServers();
    const stack = await startNetworkStack({
      allowlist: ["pypi.org", "files.pythonhosted.org"],
      dnsServers,
      mihomoPath: findMihomo(),
      slirp4netnsPath: findSlirp4netns(),
    });
    try {
      expect(
        await execInStack(
          stack,
          "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://pypi.org/simple/",
        ),
      ).toContain("200");

      const out = await execInStack(
        stack,
        "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com",
      );
      // 未允许域名在 DNS 层被拒（不在 fake-ip 白名单里 → 落到 rcode://name_error）：
      // 报 Could not resolve host，而非 fake-ip 后连接层断（TLS decode error）
      expect(out).toMatch(/Could not resolve host|Temporary failure in name resolution/);

      // 监听入口：宿主 resolv.conf 指向 loopback stub 时走的就是它，显式查本机地址的 53
      expect(await execInStack(stack, "dig +short @127.0.0.1 -p 53 pypi.org")).toMatch(
        /^198\.18\./,
      );

      // 沙箱内解析配置保持宿主原样：stub 由栈内监听接管，不改写文件
      const hostResolv = await readFile("/etc/resolv.conf", "utf8");
      expect(await execInStack(stack, "cat /etc/resolv.conf")).toBe(hostResolv);
    } finally {
      await stack.stop();
    }
  }, 90000);

  // 回归：预览（--print-args）与实际执行的命令行必须逐项一致，含 nsenter 前缀。
  // 用打印自身 argv 的假 bwrap 替换执行体：nsenter 进 netns 后它只回显收到的参数，
  // 因此「真正跑的那条命令行」在测试里可见。
  it("executes exactly the argv the preview prints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwrap-argv-"));
    const fakeBwrap = join(dir, "fake-bwrap");
    writeFileSync(fakeBwrap, '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n', { mode: 0o755 });
    const fakeStrategy = resolveBwrap(
      completeBwrapConfig({
        fs: { mode: "workspace-write" },
        network: { mode: "limited" },
        bwrapPath: fakeBwrap,
      }),
    );
    const stack = await startNetworkStack({
      allowlist: [],
      dnsServers: process.env.NETSTACK_DNS ? [process.env.NETSTACK_DNS] : await resolveDnsServers(),
      mihomoPath: findMihomo(),
      slirp4netnsPath: findSlirp4netns(),
    });
    try {
      const invocation = await buildBwrapInvocation(fakeStrategy, dir, "echo 1");
      const previewArgv = invocationArgv(invocation, stack.holderPid);
      let out = "";
      await execInvocation(invocation, {
        cwd: dir,
        holderPid: stack.holderPid,
        onData: (data: Buffer) => {
          out += data.toString();
        },
      });
      const invoked = out.trim().split("\n");
      // nsenter 消费掉自己的前缀后 exec 目标程序：目标程序看到的 argv 就是 bwrap 命令行
      // 本身，预览在它前面多出「进入该 holder netns」的前缀。
      expect(invoked).toEqual(invocationArgv(invocation));
      expect(previewArgv).toEqual([
        "nsenter",
        "-U",
        "-n",
        "--preserve-credentials",
        "-t",
        String(stack.holderPid),
        "--",
        ...invoked,
      ]);
    } finally {
      await stack.stop();
    }
  }, 60000);

  // 回归：正常停栈必须报告「这次是我们停的」，且重复调用幂等——正常路径要注销 GC 兜底，
  // 否则对象被回收后会再对可能已被内核复用的 pid 发一次信号。
  it("reports a normal stop without diagnostics and is idempotent", async () => {
    const stack = await startNetworkStack({
      allowlist: [],
      dnsServers: await resolveDnsServers(),
      mihomoPath: findMihomo(),
      slirp4netnsPath: findSlirp4netns(),
    });
    const first = await stack.stop();
    expect(first).toEqual({ exitedEarly: false });
    expect(await stack.stop()).toEqual(first);
  }, 60000);

  // 回归：常规停栈不得按 pid 发信号——「检查子进程是否已退出」与「发信号」之间不是
  // 原子的，子进程可能在检查通过后退出、pid 被内核复用，信号会落到无关进程上。停栈必须
  // 走 fd 通道（关 holder 的 stdin → holder 自行退出 → 内核清理 pid ns → exit-fd HUP
  // → slirp4netns 自行退出）。
  it("stops without sending any signal to a pid", async () => {
    const kill = vi.spyOn(ChildProcess.prototype, "kill");
    try {
      const stack = await startNetworkStack({
        allowlist: [],
        dnsServers: await resolveDnsServers(),
        mihomoPath: findMihomo(),
        slirp4netnsPath: findSlirp4netns(),
      });
      await stack.stop();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  }, 60000);

  // 回归：holder 在停栈前自行退出（运行期崩溃）时必须留档——此前缓冲里的 holder /
  // slirp 输出只在启动失败时落盘，运行期崩溃的死因被直接丢弃。
  it("persists diagnostics when the stack dies before stopping", async () => {
    const stack = await startNetworkStack({
      allowlist: [],
      dnsServers: await resolveDnsServers(),
      mihomoPath: findMihomo(),
      slirp4netnsPath: findSlirp4netns(),
    });
    process.kill(stack.holderPid, "SIGKILL");
    expect(await waitForPidGone(stack.holderPid, 5000)).toBe(true);
    // Node 在 waitpid 之后才更新子进程的 exitCode，等它一拍再停栈
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await stack.stop();
    expect(result.exitedEarly).toBe(true);
    const logPath = result.logPath ?? "";
    expect(logPath).not.toBe("");
    const content = await readFile(logPath, "utf8");
    expect(content).toContain("Network stack exited during command execution");
    await rm(logPath, { force: true });
  }, 60000);

  // 回归：egress 接口没建起来时必须立刻以带原因的失败结束，而不是继续启动过滤进程、
  // 让宿主侧在 20 秒后把它呈现为「过滤进程就绪超时」。直接在宿主 netns 跑 holder：
  // 没有 slirp4netns 创建 tap0，holder 必须自己发现并退出（宿主上通常不存在 tap0）。
  it("fails fast when the egress interface is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwrap-holder-"));
    const holderPath = fileURLToPath(new URL("../src/bwrap/holder.js", import.meta.url));
    // 配置用 base64("{}")：tap0 缺失时根本不会走到启动过滤进程这一步
    // stdin 必须是保持打开的 pipe：给 /dev/null 会让 holder 立刻读到 EOF 并自杀
    const child = spawn(process.execPath, [holderPath, "e30=", findMihomo(), "1500", dir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", (exitCode) => resolve(exitCode));
    });
    child.kill("SIGKILL");
    expect(code).toBe(1);
    expect(stderr).toContain("did not create tap0");
  }, 20000);
});
