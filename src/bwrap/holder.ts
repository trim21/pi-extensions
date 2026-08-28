/* eslint-disable no-console, unicorn/no-process-exit -- 独立 CLI 脚本，由 unshare 直接执行 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// 用法：unshare -Urn node holder.ts <config> <singbox>
const args = process.argv.slice(2);
const configPath = args[0];
const singBoxPath = args[1];
if (!configPath || !singBoxPath) {
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

  // sing-box 日志透传到 holder 的 stdout/stderr，宿主侧监听 "sing-box started" 判定就绪
  const singbox = spawn(singBoxPath, ["run", "-c", configPath], {
    env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: "true" },
    stdio: ["ignore", "inherit", "inherit"],
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

  await new Promise<void>((resolve) => singbox.once("exit", () => resolve()));
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
