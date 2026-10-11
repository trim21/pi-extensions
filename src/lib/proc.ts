import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

/** 子进程是否已结束（正常退出或被信号杀死）。 */
export function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * 向自己 spawn 的子进程强杀。已结束（Node 已回收）的子进程不会再收到信号。
 *
 * 注意这不是「保证不会误杀」的手段：子进程可能在我们检查之后、发信号之前退出，
 * 而 Node 最终仍按 pid 调 kill(2)（libuv 的 uv_process_kill），此时该 pid 可能已被
 * 内核复用给无关进程。只应作为「进程卡死」时的最后手段，常规终止请走不依赖 pid 的
 * 通道（例如关闭子进程持有的管道写端让它自行退出）。
 */
export function killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (childHasExited(child)) {
    return false;
  }
  return child.kill(signal);
}

/** 等待子进程结束，返回是否在超时内结束；已结束的立即返回 true。 */
export async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) {
    return true;
  }
  // AbortSignal.timeout 的定时器不保持事件循环活跃，子进程先退出时它自行失效
  const timeout = AbortSignal.timeout(timeoutMs);
  const timedOut = new Promise<false>((resolve) => {
    timeout.addEventListener("abort", () => resolve(false), { once: true });
  });
  // spawn 失败（error 事件）也算「已经结束」，避免把失败挂成未处理的 rejection
  const exited = once(child, "exit")
    .then(() => true)
    .catch(() => true);
  return Promise.race([exited, timedOut]);
}

/**
 * 按行消费输出流：data 事件按 buffer 边界切分，行可能跨多个 chunk，
 * 这里拼接缓冲后按 \n 逐行回调（回调不含换行符）。
 * 回调返回 false 可提前停止消费；流的 error 会以 rejection 形式抛出。
 */
export async function forEachLine(
  stream: NodeJS.ReadableStream,
  callback: (line: string) => boolean | void,
): Promise<void> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (callback(line) === false) {
        return;
      }
    }
  }
}
