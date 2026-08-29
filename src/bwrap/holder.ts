/* eslint-disable no-console, unicorn/no-process-exit -- 独立 CLI 脚本，由 unshare 直接执行 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// 用法：unshare -Urnp --fork --kill-child node holder.ts <config-base64> <mihomo> <mtu> <mihomo-home-dir>
// 本进程是 pid namespace 的 init：无论以何种方式退出（含 SIGKILL），内核都会清理该 pid ns 内的
// mihomo，userns/netns 引用随之归零。slirp4netns 由宿主侧启动（egress 必须留在宿主 netns，
// 否则出站流量会绕回 mihomo 的 TUN 被 dns-hijack 自劫持），它通过 exit-fd 绑定本进程的生命周期：
// fd 3 是 exit-fd 的写端（network-stack 经 unshare 传入），本进程存活期间保持打开，死亡即关闭，
// slirp4netns 侧收到 HUP 自行退出并释放 tap fd，netns 引用随之归零。
const args = process.argv.slice(2);
const configBase64 = args[0];
const mihomoPath = args[1];
const tunMtu = Number(args[2]);
const mihomoHome = args[3];
if (!configBase64 || !mihomoPath || !tunMtu || !mihomoHome) {
  process.exit(2);
}

// mihomo 不写工作目录（配置经 -config 直传），切到根目录防止在宿主 cwd 意外落盘
process.chdir("/");

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
  // 这里读到 EOF 即自杀（init 退出即触发内核清理整个 pid ns，顺带关闭 exit-fd 写端）。
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));

  // tap0 由宿主侧的 slirp4netns（fork 进本 netns）创建，就绪后再拉起 mihomo。
  // mihomo 日志透传到 holder 的 stdout/stderr，宿主侧监听 "Tun adapter listening" 判定就绪。
  await waitFor(100, 100, tap0Exists);

  const mihomo = spawn(mihomoPath, ["-d", mihomoHome, "-config", configBase64], {
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
