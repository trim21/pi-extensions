import { spawn } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
const args = process.argv.slice(2);
const configPath = args[0];
const singBoxPath = args[1];
const readyFile = args[2];
if (!configPath || !singBoxPath || !readyFile) {
  process.exit(2);
}
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
  await waitFor(100, 100, tap0Exists);
  const logPath = `${configPath}.log`;
  const logFd = await open(logPath, "w");
  const singbox = spawn(singBoxPath, ["run", "-c", configPath], {
    env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: "true" },
    stdio: ["ignore", logFd.fd, logFd.fd]
  });
  const stop = () => {
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
  await waitFor(200, 100, async () => {
    try {
      const log = await readFile(logPath, "utf8");
      return log.includes("sing-box started");
    } catch {
      return false;
    }
  });
  await writeFile(readyFile, "");
  await new Promise((resolve) => singbox.once("exit", () => resolve()));
}
try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
