import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
const args = process.argv.slice(2);
const configBase64 = args[0];
const mihomoPath = args[1];
const slirp4netnsPath = args[2];
const tunMtu = Number(args[3]);
if (!configBase64 || !mihomoPath || !slirp4netnsPath || !tunMtu) {
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
  const status = await readFile("/proc/self/status", "utf8");
  const hostPid = /^NSpid:\s+(.+)$/m.exec(status)?.[1].split(/\s+/, 1)[0];
  if (!hostPid) {
    throw new Error("Failed to resolve host pid from NSpid");
  }
  spawn(slirp4netnsPath, ["-c", `--mtu=${tunMtu}`, "--netns-type=pid", hostPid, "tap0"], {
    stdio: ["ignore", "inherit", "inherit"]
  });
  await waitFor(100, 100, tap0Exists);
  const mihomo = spawn(mihomoPath, ["-config", configBase64], {
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
