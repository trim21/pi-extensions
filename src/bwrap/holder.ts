/* eslint-disable no-console, unicorn/no-process-exit -- 独立 CLI 脚本，由 unshare 直接执行 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// 用法：unshare -Urnp --fork --kill-child node holder.ts <config> <mihomo> <slirp4netns> <mtu>
// 本进程是 pid namespace 的 init：无论以何种方式退出（含 SIGKILL），内核都会清理该 pid ns 内的
// slirp4netns / mihomo，userns/netns 引用随之归零。
const args = process.argv.slice(2);
const configPath = args[0];
const mihomoPath = args[1];
const slirp4netnsPath = args[2];
const tunMtu = Number(args[3]);
if (!configPath || !mihomoPath || !slirp4netnsPath || !tunMtu) {
  process.exit(2);
}

function tap0Exists(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ip", ["link", "show", "tap0"], { stdio: "ignore" });
    child.once("exit", (code) => resolve(code === 0));
    child.once("error", () => resolve(false));
  });
}

async function waitFor(
  attempts: number,
  delayMs: number,
  predicate: () => Promise<boolean>,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await sleep(delayMs);
  }
  return false;
}

async function main(): Promise<void> {
  // 宿主（pi）进程死亡检测：宿主以任何方式退出（含 SIGKILL）都会关闭它持有的 stdin 写端，
  // 这里读到 EOF 即自杀（init 退出即触发内核清理整个 pid ns），顺带删除配置目录。
  process.stdin.resume();
  process.stdin.on("end", () => {
    rmSync(dirname(configPath), { recursive: true, force: true });
    process.exit(0);
  });

  // 宿主视角 pid（NSpid 第一项）：/proc 挂载是宿主的（-Urnp 不含 -m，宿主视角下
  // /proc/1 是 systemd 而非本 pid ns 的 init），slirp4netns 的 setns 必须走宿主 /proc
  const status = await readFile("/proc/self/status", "utf8");
  const hostPid = /^NSpid:\s+(.+)$/m.exec(status)?.[1].split(/\s+/, 1)[0];
  if (!hostPid) {
    throw new Error("Failed to resolve host pid from NSpid");
  }

  // slirp4netns 提供 egress：本进程已在目标 userns/netns 内，setns 到自身 netns（no-op）；
  // 日志 inherit 到 holder 的 stdout/stderr，宿主侧诊断（--verbose）可见
  spawn(slirp4netnsPath, ["-c", `--mtu=${tunMtu}`, "--netns-type=pid", hostPid, "tap0"], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  // mihomo 日志透传到 holder 的 stdout/stderr，宿主侧监听 "Tun adapter listening" 判定就绪
  await waitFor(100, 100, tap0Exists);

  const mihomo = spawn(mihomoPath, ["-d", dirname(configPath), "-f", configPath], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  const stop = (): void => {
    mihomo.kill("SIGTERM");
  };
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });

  await new Promise<void>((resolve) => mihomo.once("exit", () => resolve()));
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
