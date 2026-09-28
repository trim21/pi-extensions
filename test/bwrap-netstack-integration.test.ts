import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

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
});
