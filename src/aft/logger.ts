/**
 * AFT 扩展日志：落盘到 agent dir 的 tmp/{sessionId}/（<agentDir>/tmp/<sessionId>/aft-plugin.log）。
 *
 * aft-bridge 会把 aft 子进程的 stderr 逐行转发给 logger；不设置 logger 时它
 * fallback 到 console.error，raw 文本直接打进 pi 进程的 stderr，破坏 TUI。
 * 这里用 RotatingLogSink（带轮转的异步追加写）承接，日志只进文件不进终端。
 */

import { join } from "node:path";

import { RotatingLogSink } from "@cortexkit/aft-bridge";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const TAG = "[aft-pi]";
const FLUSH_INTERVAL_MS = 500;
const BUFFER_SIZE_LIMIT = 50;

/** aft-bridge 的 Logger 接口 + drain。 */
export interface AftLogger {
  log(message: string, meta?: { sessionId?: string }): void;
  warn(message: string, meta?: { sessionId?: string }): void;
  error(message: string, meta?: { sessionId?: string }): void;
  getLogFilePath(): string;
  /** 立即落盘，供测试与关闭路径使用。 */
  drain(): Promise<void>;
}

export function createAftLogger(sessionId?: string): AftLogger {
  let sink: RotatingLogSink | null = null;
  let buffer: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function logFilePath(): string {
    return sessionId
      ? join(getAgentDir(), "tmp", sessionId, "aft-plugin.log")
      : join(getAgentDir(), "tmp", "aft-plugin.log");
  }

  // sink 懒创建：getAgentDir() 读 PI_CODING_AGENT_DIR，测试里先改 env 再触发写入。
  function getSink(): RotatingLogSink {
    sink ??= new RotatingLogSink(logFilePath());
    return sink;
  }

  function flush(): void {
    if (buffer.length === 0) return;
    const data = buffer.join("");
    buffer = [];
    try {
      getSink().append(data);
    } catch {
      // 日志绝不抛错
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_INTERVAL_MS);
    if (typeof flushTimer === "object" && "unref" in flushTimer) {
      flushTimer.unref();
    }
  }

  function write(level: string, message: string, lineSessionId?: string): void {
    try {
      const timestamp = new Date().toISOString();
      const sessionPrefix = lineSessionId ? ` [${lineSessionId}]` : "";
      buffer.push(`[${timestamp}] ${level} ${TAG}${sessionPrefix} ${message}\n`);
      if (buffer.length >= BUFFER_SIZE_LIMIT) {
        flush();
      } else {
        scheduleFlush();
      }
    } catch {
      // 日志绝不抛错
    }
  }

  return {
    log(message, meta) {
      write("INFO", message, meta?.sessionId);
    },
    warn(message, meta) {
      write("WARN", message, meta?.sessionId);
    },
    error(message, meta) {
      write("ERROR", message, meta?.sessionId);
    },
    getLogFilePath: logFilePath,
    drain: async (): Promise<void> => {
      flush();
      if (sink) await sink.drain();
    },
  };
}
