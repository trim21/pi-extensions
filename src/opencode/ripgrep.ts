/**
 * ripgrep 运行器，供 opencode 风格 grep / glob 复用。
 *
 * 对齐上游 packages/core/src/ripgrep.ts 的 run()：以 `rg` 子进程流式读取
 * stdout，按解析结果计数，读满 limit + 1 条即杀掉进程提前结束（宽泛 pattern
 * 不会把整个结果集读进内存）。退出码语义与上游一致：0 成功、1 无匹配、2 部分
 * 文件读失败（仍返回已收集的结果），正则语法错误单独报错。
 */

import { spawn } from "node:child_process";

/** 单次搜索最多返回的结果数（上游 limit = 100）。 */
export const RIPGREP_RESULT_LIMIT = 100;

/** stderr 最多保留的字节数（上游 ERROR_BYTES）。 */
const ERROR_BYTES = 8 * 1024;

export interface RipgrepRunOptions<R> {
  cwd: string;
  signal?: AbortSignal;
  /** 最多返回的解析结果数；读满 limit + 1 条即终止 rg。 */
  limit: number;
  /** 解析一行 stdout；返回 undefined 表示该行不是结果（如 rg 的 begin/end/summary 记录）。 */
  parse: (line: string) => R | undefined;
}

export interface RipgrepRunResult<R> {
  items: R[];
  /** 结果数超过 limit，已提前终止 rg（可能还有更多结果）。 */
  truncated: boolean;
}

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex");

/**
 * 跑一次 rg 并返回解析后的结果。
 *
 * 路径类参数用 `--` 与 pattern 分隔，pattern 不会被当成选项；调用方负责给出
 * `--no-config`、`--glob` 等选项。
 */
export function runRipgrep<R>(
  args: string[],
  options: RipgrepRunOptions<R>,
): Promise<RipgrepRunResult<R>> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("rg", args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const { signal } = options;
    // 事件回调之间共享的状态放进对象：闭包里的 let 会被 TS 控制流判定为「恒假」，
    // 触发 eslint 的 no-unnecessary-condition 误报
    const state = { done: false, settled: false, truncated: false };
    let stderr = "";
    let parseError: Error | undefined;
    let pending = "";
    const items: R[] = [];

    const stop = () => {
      if (state.done) return;
      state.done = true;
      child.kill("SIGTERM");
    };

    /** 收尾（resolve/reject 只会发生一次，并摘掉 abort 监听）。 */
    const settle = (finish: () => void) => {
      if (state.settled) return;
      state.settled = true;
      signal?.removeEventListener("abort", onAbort);
      finish();
    };

    const parseLine = (line: string) => {
      if (state.done || line.length === 0) return;
      let item: R | undefined;
      try {
        item = options.parse(line);
      } catch (error) {
        // 解析失败来自事件回调，必须转成 reject，否则会变成未捕获异常
        parseError = error instanceof Error ? error : new Error(String(error));
        stop();
        return;
      }
      if (item === undefined) return;
      items.push(item);
      if (items.length <= options.limit) {
        return;
      }

      state.truncated = true;
      stop();
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < ERROR_BYTES) stderr += chunk;
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      // 末尾没有换行的部分是不完整记录，留到下一块
      pending = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
    });

    child.on("error", (error) => {
      // spawn 失败（rg 不在 PATH 等）时 close 不保证触发，必须在这里收尾，
      // 否则 promise 永远不落定，工具调用会挂住
      settle(() => {
        reject(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error("ripgrep (rg) was not found on PATH; install ripgrep to use this tool.", {
                cause: error,
              })
            : error,
        );
      });
    });

    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });

    // pending 里剩下的内容按定义是不完整记录（rg 的记录一律以 \n 收尾，
    // 被 kill 时可能停在半条），直接丢掉
    child.on("close", (code) => {
      settle(() => {
        // 取消优先于结果与退出码：调用方靠 throwIfAborted 统一处理取消
        if (signal?.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
          return;
        }
        if (parseError) {
          reject(parseError);
          return;
        }
        if (state.truncated) {
          resolve({ items: items.slice(0, options.limit), truncated: true });
          return;
        }
        const message = stderr.trim();
        if (code === 2 && isInvalidPattern(message)) {
          reject(new Error(`Invalid pattern: ${message}`));
          return;
        }
        if (code !== 0 && code !== 1 && code !== 2) {
          reject(new Error(message || `ripgrep exited with code ${code}`));
          return;
        }
        // 退出码 1 = 无匹配；退出码 2 = 部分文件读失败，已有结果照常返回
        resolve({ items: code === 1 ? [] : items, truncated: false });
      });
    });
  });
}
