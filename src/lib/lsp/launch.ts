/**
 * LSP 服务器子进程启动封装：stdin/stdout/stderr 全 pipe 交给 JSON-RPC 层使用。
 */

import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "node:child_process";

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Windows 上 .cmd/.bat 不能直接 CreateProcess，必须经 cmd.exe /c 执行 */
const CMD_SCRIPT_RE = /\.(cmd|bat)$/i;

const quoteWinArg = (value: string): string =>
  /\s|"/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

function windowsScriptCmd(cmd: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !CMD_SCRIPT_RE.test(cmd)) {
    return { command: cmd, args };
  }
  return {
    // /s 由 cmd 自行处理外层引号；COMSPEC 缺省时用 PATH 里的 cmd.exe
    command: process.env.COMSPEC ?? "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `${quoteWinArg(cmd)} ${args.map((arg) => quoteWinArg(arg)).join(" ")}`,
    ],
  };
}

export function spawnProcess(
  cmd: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcessWithoutNullStreams {
  const { command, args: spawnArgs } = windowsScriptCmd(cmd, args);
  return nodeSpawn(command, spawnArgs, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
