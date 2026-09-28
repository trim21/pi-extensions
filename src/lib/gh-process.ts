/**
 * `gh` subprocess adapter: start a `gh` process, collect its output, apply the
 * shared timeout / kill semantics, and hand it the proxy env from the shared
 * egress layer. It lives in `lib/` so both the gh tool layer (`src/gh/`) and
 * the octokit clients (`lib/github.ts`) can depend on it without a cycle.
 */

import { spawn } from "node:child_process";

import { egress } from "./egress.js";

export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  combined: string;
  /** Why the process was killed, when `killed` is true. */
  reason?: "timeout" | "abort";
  /** When the process could not be started at all (e.g. `gh` not found in PATH). */
  spawnError?: string;
}

export interface GhRunContext {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
  /** 追加到子进程环境变量（覆盖进程环境与代理配置），供测试或调用方定制。 */
  env?: NodeJS.ProcessEnv;
}

export function runGh(args: string[], ctx: GhRunContext): Promise<GhResult> {
  return new Promise((resolve) => {
    const proc = spawn("gh", args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // gh 是 Go 程序，只认环境变量形式的代理配置；ctx.env 最后合并，调用方可覆盖。
      env: { ...process.env, ...egress.env, ...ctx.env, GH_PAGER: "cat" },
    });

    let stdout = "";
    let stderr = "";
    const combined: string[] = [];
    let killed = false;
    let killReason: "timeout" | "abort" | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const killProcess = (reason: "timeout" | "abort") => {
      if (killed) {
        return;
      }

      killed = true;
      killReason = reason;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5000);
    };

    if (ctx.signal) {
      onAbort = () => killProcess("abort");
      if (ctx.signal.aborted) {
        killProcess("abort");
      } else {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Default timeout: 10 minutes. Long operations like downloading a CI job's
    // full log routinely take well over 30s, so a short default would kill them
    // mid-transfer; combined with `code ?? 0` that would silently cache a
    // truncated log as success. A killed process must never look successful.
    const timeout = ctx.timeout ?? 600_000;
    if (timeout > 0) {
      timeoutId = setTimeout(() => killProcess("timeout"), timeout);
    }

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      combined.push(text);
    });
    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      combined.push(text);
    });

    proc.on("close", (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (onAbort && ctx.signal) {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      resolve({
        stdout,
        stderr,
        // When killed by a signal the close event's code is null — including
        // kills we did not initiate. Report failure instead of pretending it
        // succeeded. -1 is a sentinel for "did not exit normally" — distinct
        // from a real gh failure exit code (1), which is always in 0-255.
        code: code ?? -1,
        killed,
        combined: combined.join(""),
        reason: killReason,
      });
    });

    proc.on("error", (err: Error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (onAbort && ctx.signal) {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      // spawn 失败（如 gh 不在 PATH → ENOENT、cwd 不存在）时进程从未启动，
      // 没有任何 stdout/stderr；把底层错误带上，否则会退化成无信息的 "exit code 1"。
      resolve({
        stdout,
        stderr,
        code: 1,
        killed,
        combined: combined.join(""),
        reason: killReason,
        spawnError: err.message,
      });
    });
  });
}

/** Read the logged-in token from the system `gh` CLI (`gh auth token`). */
export async function ghAuthToken(): Promise<string> {
  const result = await runGh(["auth", "token"], { timeout: 10_000 });
  if (result.spawnError) {
    throw new Error(`failed to start gh: ${result.spawnError}`);
  }
  const token = result.stdout.trim();
  if (token && result.code === 0) {
    return token;
  }
  throw new Error(
    result.stderr.trim() ||
      `gh auth token exited with code ${result.code} — run "gh auth login" first`,
  );
}
