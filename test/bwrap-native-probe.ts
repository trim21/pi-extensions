/**
 * 共享的 host 探测：原生执行器能否在当前环境跑通一条最小命令。
 *
 * 二进制缺失、平台不支持、或环境不允许嵌套 user/pid namespace（受限 CI、嵌套沙箱）
 * 都返回 false，调用方据此跳过整组真实沙箱用例，避免报假失败。
 */
import { spawnSync } from "node:child_process";

import { findBwrap } from "../src/bwrap/core.js";
import { resolveSandboxBinary } from "../src/bwrap/executor.js";

export function nativeSandboxUsable(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  let binary: string;
  let bwrap: string;
  try {
    binary = resolveSandboxBinary();
    bwrap = findBwrap();
  } catch {
    return false;
  }
  const policy = {
    root: "/",
    mounts: [{ path: "/tmp", mode: "rw-try" }],
    extraArgs: [],
    network: { mode: "block", allowlist: [], dnsServers: [] },
    mihomo: { path: "", mtu: 1500 },
    slirp4netns: { path: "" },
    bwrap: { path: bwrap },
    command: "true",
    shell: "/bin/bash",
    cwd: "/tmp",
    env: { HOME: process.env.HOME ?? "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin" },
    timeoutSeconds: 10,
  };
  const probe = spawnSync(
    binary,
    ["run", "--policy-base64", Buffer.from(JSON.stringify(policy)).toString("base64")],
    { timeout: 20000 },
  );
  return probe.status === 0;
}
