/**
 * orphan-worker-cleaner —— 宿主消失时让 pi SDK worker 自行退出
 *
 * VS Code 的 pi 扩展（Pendant）用 fork 启动 dist/pi-sdk-worker.cjs 承载 pi SDK。
 * 宿主进程消失时 worker 不会退出：worker 侧只把 IPC 断连当成可重试的传输错误
 * 上报，既不清理也不自杀，于是留下 ppid=1 的孤儿，连同它拉起的 language server
 * （实测单个 worker 身上挂 4 GiB 上下）一起常驻。
 *
 * 这里只做一件事：定时看一眼自己的父进程还在不在（父进程退出后会被 init 收养，
 * ppid 变成 1），不在就退出。worker 一退，它拉起的 language server 会因为 stdin
 * 关闭自行退出，language server 退出时（process.on("exit") → shutdown()）又会
 * kill 掉自己 fork 的 tsserver，整棵树随之消失 —— 所以不需要遍历或清理别的进程。
 *
 * 只对 fork 出来的 SDK worker 生效（process.channel 存在）：CLI 直跑、以及 pi
 * 内部 spawn 出来的进程都没有 IPC channel，不在此列，不会被误伤。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 检查父进程是否还在的间隔 */
export const DEFAULT_CHECK_INTERVAL_MS = 5_000;

export default function orphanWorkerCleaner(pi: ExtensionAPI): void {
  if (process.channel === undefined) {
    return;
  }
  const timer = setInterval(() => {
    if (process.ppid === 1) {
      // eslint-disable-next-line unicorn/no-process-exit -- 宿主已经没了，worker 必须整体退出
      process.exit(0);
    }
  }, DEFAULT_CHECK_INTERVAL_MS);
  timer.unref();

  pi.on("session_shutdown", () => {
    clearInterval(timer);
  });
}
