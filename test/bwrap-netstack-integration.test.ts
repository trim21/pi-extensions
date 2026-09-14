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

// 需要真实 mihomo/slirp4netns/unshare 与可出网的 DNS，常规 CI 不满足；
// 手动用 RUN_NETSTACK_INTEGRATION=1 运行。某些环境的系统 DNS 走 slirp4netns
// 出站不可达时，可用 NETSTACK_DNS 指定一个可通的 DNS（如 NETSTACK_DNS=223.5.5.5）。
describe.skipIf(process.env.RUN_NETSTACK_INTEGRATION !== "1")("NetworkStack integration", () => {
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
      // 未允许域名在 DNS 层被拒（mihomo dns.rules MATCH,REJECT）：
      // 报 Could not resolve host，而非 fake-ip 后连接层断（TLS decode error）
      expect(out).toMatch(/Could not resolve host|Temporary failure in name resolution/);
    } finally {
      await stack.stop();
    }
  }, 90000);
});
