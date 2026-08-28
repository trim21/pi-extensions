/* eslint-disable no-console, unicorn/no-process-exit -- 独立 CLI 脚本，由 unshare 直接执行 */
import { spawn } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

// 用法：unshare -Urn node holder.ts <config> <singbox> <ready-file>
const args = process.argv.slice(2);
const configPath = args[0];
const singBoxPath = args[1];
const readyFile = args[2];
if (!configPath || !singBoxPath || !readyFile) {
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
  // slirp4netns 由宿主侧 spawn，这里等它建好 tap0
  await waitFor(100, 100, tap0Exists);

  const logPath = `${configPath}.log`;
  const logFd = await open(logPath, "w");
  const singbox = spawn(singBoxPath, ["run", "-c", configPath], {
    env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: "true" },
    stdio: ["ignore", logFd.fd, logFd.fd],
  });

  const stop = (): void => {
    singbox.kill("SIGTERM");
  };
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });

  // tun0 设备在 sing-box 启动早期就创建，但 gvisor 栈初始化仍需时间；
  // 以 "sing-box started" 日志作为进程就绪标志，再等待栈初始化完成
  await waitFor(200, 100, async () => {
    try {
      const log = await readFile(logPath, "utf8");
      return log.includes("sing-box started");
    } catch {
      return false;
    }
  });
  await sleep(4000);
  await writeFile(readyFile, "");

  await new Promise<void>((resolve) => singbox.once("exit", () => resolve()));
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
