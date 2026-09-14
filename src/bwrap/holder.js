import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const args = process.argv.slice(2);
const configBase64 = args[0];
const mihomoPath = args[1];
const tunMtu = Number(args[2]);
const mihomoHome = args[3];
if (!configBase64 || !mihomoPath || !tunMtu || !mihomoHome) {
  process.exit(2);
}
process.chdir("/");
function tap0Exists() {
  return new Promise((resolve) => {
    const child = spawn("ip", ["link", "show", "tap0"], { stdio: "ignore" });
    child.once("exit", (code) => resolve(code === 0));
    child.once("error", () => resolve(false));
  });
}
async function waitFor(attempts, delayMs, predicate) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await sleep(delayMs);
  }
  return false;
}
async function main() {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  await waitFor(100, 100, tap0Exists);
  const mihomo = spawn(mihomoPath, ["-d", mihomoHome, "-config", configBase64], {
    stdio: ["ignore", "inherit", "inherit"]
  });
  const stop = () => {
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
  await new Promise((resolve) => mihomo.once("exit", () => resolve()));
}
try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
