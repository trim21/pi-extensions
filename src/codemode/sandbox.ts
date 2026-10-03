/**
 * codemode 的沙箱客户端：宿主侧管理脚本子进程的一轮执行。
 *
 * 每次 `run()` 起一个 `bwrap … node bootstrap.js`（用户命名空间、pid 命名空间、只读根，
 * 具体边界由 `ResolvedBwrap` 决定——与 Bash 沙箱同一份配置），脚本就是那个进程；协议走
 * spawn 建的那条全双工 socketpair（见 `CHILD_FRAME_FD`），stdin/stdout/stderr 全归脚本
 * （stdout/stderr 收集成脚本输出项）。跑完即杀掉整个进程组。
 *
 * 拿不到 bwrap 时不会静默降级：先由调用方请求用户授权（`approveUnsandboxed`），
 * 授权后以普通子进程执行，否则直接失败。
 *
 * 与 bwrap 层的分工：命令行组装与网络栈生命周期在 `src/bwrap/sandbox.ts`
 * （`spawnSandboxed`），这里只管协议、工具调用转发、输出收集与回收。
 */

import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import type { ResolvedBwrap } from "../bwrap/core.js";
import { type SandboxedProcess, spawnSandboxed } from "../bwrap/sandbox.js";
import {
  CHILD_FRAME_FD,
  type ChildMessage,
  type CodemodeOutputItem,
  createFrameDecoder,
  decodeChildMessage,
  encodeFrame,
  type HostMessage,
  type ScriptError,
  type ScriptTool,
  type StoreWrites,
} from "./protocol.js";

/** 脚本侧一次嵌套调用的记录（宿主是执行方，所以由它记录）。 */
export interface ScriptCall {
  name: string;
  status: "ok" | "error";
  durationMs: number;
}

export type SandboxCallOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export type SandboxOutcome = {
  output: CodemodeOutputItem[];
  calls: ScriptCall[];
} & (
  | { ok: true; value: unknown; writes: StoreWrites }
  | { ok: false; error: ScriptError; writes: StoreWrites }
);

/** 本次执行生效的沙箱视图（由 bwrap runtime 给出，见 `BwrapRuntime.sandboxView`）。 */
export interface SandboxView {
  resolved: ResolvedBwrap;
  /** bwrap 二进制不可用：这次执行要么不需要沙箱，要么得先拿到用户授权。 */
  bwrapUnavailable: boolean;
}

export interface SandboxRunOptions {
  code: string;
  tools: readonly ScriptTool[];
  store: Record<string, unknown>;
  /** 沙箱工作区（也是脚本子进程的 cwd：相对路径按它解析）。 */
  workspace: string;
  sandbox: SandboxView;
  /**
   * 需要沙箱但 bwrap 不可用时，请求用户授权以普通子进程执行；返回 false 即放弃执行。
   * 缺省（无 UI 等）表示拒绝——调用方负责给出拒绝文案。
   */
  approveUnsandboxed?(): Promise<boolean>;
  /** 调用方中止本次执行。 */
  signal?: AbortSignal;
  /**
   * 整个执行的墙钟上限（毫秒）：从子进程起好开始算，到点杀掉整个进程组并以 `timeout` 结束。
   * 不传表示不限时（策略由调用方决定，见 `DEFAULT_TIMEOUT_MS`）。
   */
  timeoutMs?: number;
  /** 每次嵌套调用：由调用方执行工具并把结果回给脚本。 */
  onCall(request: { id: number; name: string; args: unknown }): Promise<SandboxCallOutcome>;
  /** 脚本流式产生的输出项，用于 toolcall 进度。 */
  onOutput?(items: readonly CodemodeOutputItem[]): void;
  /** 嵌套调用的开始与结束，用于 toolcall 进度。 */
  onCallProgress?(event: {
    phase: "start" | "finish";
    name: string;
    args?: unknown;
    status?: string;
  }): void;
}

export interface CodemodeSandbox {
  run(options: SandboxRunOptions): Promise<SandboxOutcome>;
}

const NO_WRITES: StoreWrites = { set: {}, delete: [] };
/** `done` 之后等子进程把 stdout/stderr 冲完的上限（管道写入在部分平台是异步的）。 */
const DRAIN_TIMEOUT_MS = 1000;

const SANDBOX_UNAVAILABLE =
  "bwrap (bubblewrap) is not available, so the script was not run. Install bubblewrap, or approve unsandboxed execution.";
const SANDBOX_NO_RESULT = "codemode child exited without reporting a result";

/**
 * 脚本入口：与这个客户端同目录的 `bootstrap.js`（`bootstrap.ts` 的 esbuild 产物，
 * 随仓库提交；pre-commit 会重新生成）。
 */
function bootstrapPath(): string {
  return fileURLToPath(new URL("bootstrap.js", import.meta.url));
}

/** 若进程仍在，杀掉整个进程组（脚本可能自己起了子进程）。 */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已退出
    }
  }
}

export function createCodemodeSandbox(): CodemodeSandbox {
  return {
    run: (options) => runOnce(options),
  };
}

/** 这次执行要不要沙箱：`"denied"` 表示需要沙箱但拿不到，且没有可用的授权路径。 */
function resolveMode(options: SandboxRunOptions): "sandboxed" | "unsandboxed" | "denied" {
  if (!options.sandbox.resolved.bwrapEnabled) {
    // 配置本身就允许全权限（fs 与 network 都 allow-all）：与 Bash 一致，不经沙箱也不问
    return "unsandboxed";
  }
  return options.sandbox.bwrapUnavailable ? "denied" : "sandboxed";
}

async function runOnce(options: SandboxRunOptions): Promise<SandboxOutcome> {
  let mode = resolveMode(options);
  if (mode === "denied") {
    const approved = (await options.approveUnsandboxed?.()) === true;
    if (!approved) {
      return fail("sandbox", SANDBOX_UNAVAILABLE);
    }
    mode = "unsandboxed";
  }

  if (options.signal?.aborted) {
    return fail("aborted", "codemode execution was aborted");
  }

  let handle: SandboxedProcess;
  try {
    handle = await spawnSandboxed(options.sandbox.resolved, {
      workspace: options.workspace,
      argv: [process.execPath, bootstrapPath()],
      cwd: options.workspace,
      unsandboxed: mode === "unsandboxed",
      // stdin 给 /dev/null：协议不占用它，脚本也不该去读宿主的输入
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return fail(
      "sandbox",
      `failed to start the codemode sandbox: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return await new Promise<SandboxOutcome>((resolve) => {
    const child: ChildProcess = handle.child;
    const output: CodemodeOutputItem[] = [];
    const calls: ScriptCall[] = [];
    const started = new Map<number, { name: string; at: number }>();
    const decoder = new StringDecoder("utf8");
    let settled = false;
    let draining: NodeJS.Timeout | undefined;
    /**
     * 收尾信号 = 调用方中止信号 + 执行上限（`AbortSignal.timeout`，它的 timer 是 unref 的，
     * 不会吊住 pi 的事件循环）。两条来源共用同一条中止路径，区别只在错误类型。
     */
    const abort = combineAbortSignals(options.signal, options.timeoutMs);
    let outcome:
      | { ok: true; value: unknown; writes: StoreWrites }
      | { ok: false; error: ScriptError; writes: StoreWrites }
      | undefined;

    function emit(items: readonly CodemodeOutputItem[]): void {
      if (items.length === 0) {
        return;
      }
      output.push(...items);
      options.onOutput?.(items);
    }

    function finish(): void {
      if (settled) {
        return;
      }
      settled = true;
      if (draining !== undefined) {
        clearTimeout(draining);
      }
      abort.combined?.removeEventListener("abort", onAbort);
      killProcessGroup(child.pid);
      void handle.close().catch(() => {
        /* 进程已经退出，收尾失败无所谓 */
      });
      const body = outcome ?? {
        ok: false as const,
        error: { kind: "sandbox" as const, message: SANDBOX_NO_RESULT },
        writes: NO_WRITES,
      };
      resolve({ ...body, output, calls });
    }

    function onAbort(): void {
      const timeoutMs = options.timeoutMs;
      outcome =
        timeoutMs !== undefined && abort.timeout?.aborted === true
          ? {
              ok: false,
              error: { kind: "timeout", message: timeoutMessage(timeoutMs) },
              writes: NO_WRITES,
            }
          : {
              ok: false,
              error: { kind: "aborted", message: "codemode execution was aborted" },
              writes: NO_WRITES,
            };
      finish();
    }

    const channel = child.stdio[CHILD_FRAME_FD] as Socket | null;

    function writeFrame(frame: HostMessage): void {
      if (!settled && channel?.writable) {
        channel.write(encodeFrame(frame));
      }
    }

    async function handleCall(id: number, name: string, args: unknown): Promise<void> {
      started.set(id, { name, at: Date.now() });
      options.onCallProgress?.({ phase: "start", name, args });
      let result: SandboxCallOutcome;
      try {
        result = await options.onCall({ id, name, args });
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const entry = started.get(id);
      started.delete(id);
      calls.push({
        name,
        status: result.ok ? "ok" : "error",
        durationMs: entry === undefined ? 0 : Date.now() - entry.at,
      });
      options.onCallProgress?.({ phase: "finish", name, status: result.ok ? "ok" : "error" });
      writeFrame(
        result.ok
          ? { t: "result", id, ok: true, value: result.value }
          : { t: "result", id, ok: false, error: result.error },
      );
    }

    function handleFrame(message: ChildMessage): void {
      if (message.t === "ready") {
        writeFrame({
          t: "start",
          code: options.code,
          tools: [...options.tools],
          store: options.store,
        });
        return;
      }
      if (message.t === "call") {
        void handleCall(message.id, message.name, message.args);
        return;
      }
      if (message.t === "output") {
        emit(message.items);
        return;
      }
      outcome = message.ok
        ? { ok: true, value: message.value, writes: message.writes }
        : { ok: false, error: message.error, writes: message.writes };
      // 等 stdout/stderr 排空：脚本的输出可能还在管道里（管道写入在部分平台是异步的），
      // 子进程冲完就自己退出，这里只做兜底
      draining = setTimeout(finish, DRAIN_TIMEOUT_MS);
      draining.unref();
    }

    const frameDecoder = createFrameDecoder({
      onFrame(value) {
        const decoded = decodeChildMessage(value);
        if (!decoded.ok) {
          outcome = {
            ok: false,
            error: {
              kind: "sandbox",
              message: `codemode child sent an invalid frame (${decoded.error})`,
            },
            writes: NO_WRITES,
          };
          finish();
          return;
        }
        handleFrame(decoded.frame);
      },
      onStray(text) {
        // 子进程往协议 fd 写了别的东西：当脚本输出报出去，不打断执行
        emit([{ type: "text", text }]);
      },
      onInvalid(reason) {
        outcome = {
          ok: false,
          error: { kind: "sandbox", message: `codemode protocol is corrupted: ${reason}` },
          writes: NO_WRITES,
        };
        finish();
      },
    });

    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        emit([{ type: "text", text: decoder.write(chunk) }]);
      });
    }
    channel?.on("data", (chunk: Buffer) => frameDecoder.push(chunk));
    channel?.on("end", () => {
      const tail = decoder.end();
      if (tail !== "") {
        emit([{ type: "text", text: tail }]);
      }
      frameDecoder.finish();
    });
    child.on("error", (error: Error) => {
      outcome ??= {
        ok: false,
        error: { kind: "sandbox", message: `codemode child failed: ${error.message}` },
        writes: NO_WRITES,
      };
      finish();
    });
    child.on("close", () => {
      outcome ??= {
        ok: false,
        error: { kind: "sandbox", message: SANDBOX_NO_RESULT },
        writes: NO_WRITES,
      };
      finish();
    });
    abort.combined?.addEventListener("abort", onAbort, { once: true });
    // 起进程这段时间里发生的命中不会回调已存在的监听器，补一次检查
    if (abort.combined?.aborted === true) {
      onAbort();
    }
  });
}

/**
 * 把调用方中止信号与执行上限合成一条信号。上限从子进程起好之后开始算：起进程前的无沙箱
 * 授权问的是用户，那段时间不该计入脚本的执行时间。
 */
function combineAbortSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { combined: AbortSignal | undefined; timeout: AbortSignal | undefined } {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  if (signal === undefined) {
    return { combined: timeout, timeout };
  }
  return { combined: timeout === undefined ? signal : AbortSignal.any([signal, timeout]), timeout };
}

/** 超时失败的消息：给出当前上限与放宽方式，模型据此改脚本或调大上限。 */
function timeoutMessage(timeoutMs: number): string {
  return (
    `codemode timed out after ${timeoutMs} ms while the script was still running.` +
    ` Raise it with \`// @options: {"timeout_ms": ${timeoutMs * 2}}\` if the script legitimately needs longer.`
  );
}

function fail(kind: ScriptError["kind"], message: string): SandboxOutcome {
  return { ok: false, error: { kind, message }, writes: NO_WRITES, output: [], calls: [] };
}
