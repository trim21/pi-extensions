/**
 * LSP 服务器子进程启动封装：stdin/stdout/stderr 全 pipe 交给 JSON-RPC 层使用。
 */

import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "node:child_process";

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function spawnProcess(
  cmd: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcessWithoutNullStreams {
  return nodeSpawn(cmd, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
