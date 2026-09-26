import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { findBwrap, findMihomo, findSlirp4netns } from "../src/bwrap/core.js";
import { resolveDnsServers, startNetworkStack } from "../src/bwrap/network-stack.js";

const bwrapArgs = [
  "--ro-bind",
  "/",
  "/",
  "--unshare-user",
  "--unshare-pid",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
];
const env = {
  HOME: process.env.HOME ?? "",
  SHELL: "/bin/bash",
  TERM: "dumb",
  LANG: "C.UTF-8",
  PATH: "/usr/local/bin:/usr/bin:/bin",
};

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
    let out = "";
    await stack.exec({
      command,
      cwd: "/tmp",
      bwrapPath: findBwrap(),
      bwrapArgs,
      shell: "/bin/bash",
      env,
      onData: (data: Buffer) => {
        out += data.toString();
      },
    });
    return out.trim();
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
      let out = "";
      await stack.exec({
        command: "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://pypi.org/simple/",
        cwd: "/tmp",
        bwrapPath: findBwrap(),
        bwrapArgs,
        shell: "/bin/bash",
        env,
        onData: (data: Buffer) => {
          out += data.toString();
        },
      });
      expect(out).toContain("200");

      out = "";
      await stack.exec({
        command: "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com",
        cwd: "/tmp",
        bwrapPath: findBwrap(),
        bwrapArgs,
        shell: "/bin/bash",
        env,
        onData: (data: Buffer) => {
          out += data.toString();
        },
      });
      // 未允许域名在 DNS 层被拒（不在 fake-ip 白名单里 → 落到 rcode://name_error）：
      // 报 Could not resolve host，而非 fake-ip 后连接层断（TLS decode error）
      expect(out).toMatch(/Could not resolve host|Temporary failure in name resolution/);
    } finally {
      await stack.stop();
    }
  }, 90000);
});
