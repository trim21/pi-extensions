/**
 * codemode 的沙箱客户端：主线程侧管理 worker 线程的一次执行与回收。
 *
 * 沙箱就是 QuickJS VM 本身（VM 里没有 node、文件、网络、timer），脚本唯一的出口是
 * 注入的工具，而这些工具由主线程执行——所以这里只做三件事：把注册时编译好的 wasm
 * 与脚本交给 worker、转发脚本的嵌套调用与输出、在结束或中止时 `terminate()`。
 *
 * worker 一次执行一个：脚本没有超时，死循环由调用方中止后 terminate 掉，连同它那份
 * VM 一起丢弃，不会污染后续执行，也不需要取消协议。
 */

import { Worker } from "node:worker_threads";

import {
  type CodemodeOutputItem,
  decodeWorkerMessage,
  type ScriptError,
  type ScriptTool,
  type StoreWrites,
  type WorkerMessage,
} from "./protocol.js";
import { compileQuickJSWasm } from "./wasm.js";

/** 脚本侧一次嵌套调用的记录（主线程是执行方，所以由它记录）。字段与 pi 内置 codemode 的嵌套调用一致，UI 直接消费。 */
export interface ScriptCall {
  /** 本次执行内唯一：`<toolCallId>/<序号>`。 */
  id: string;
  name: string;
  /** 参数的紧凑 JSON（过长时截断），供 UI 显示。 */
  args: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  /** 失败时的错误文本。 */
  error?: string;
}

export type SandboxCallOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export type SandboxOutcome = {
  output: CodemodeOutputItem[];
  calls: ScriptCall[];
} & (
  | { ok: true; value: unknown; writes: StoreWrites }
  | { ok: false; error: ScriptError; writes: StoreWrites }
);

export interface SandboxRunOptions {
  code: string;
  tools: readonly ScriptTool[];
  store: Record<string, unknown>;
  /** 本次工具调用的 id，用于给嵌套调用生成稳定的 `id`。 */
  toolCallId: string;
  /** 调用方中止本次执行；脚本没有自己的超时，死循环只能靠它结束。 */
  signal?: AbortSignal;
  /**
   * 本次执行的墙钟预算（毫秒），含等待嵌套调用的时间；缺省不设上限。
   * 到点后执行以 `kind: "timeout"` 结束，正在跑的嵌套调用收到中止信号。
   */
  timeoutMs?: number;
  /** 每次嵌套调用：由调用方执行工具并把结果回给脚本。`signal` 含调用方中止与本次预算。 */
  onCall(request: {
    id: number;
    name: string;
    args: unknown;
    signal: AbortSignal;
  }): Promise<SandboxCallOutcome>;
  /** 脚本流式产生的输出项，用于 toolcall 进度。 */
  onOutput?(items: readonly CodemodeOutputItem[]): void;
  /** 嵌套调用的开始与结束，用于 toolcall 进度；事件里带截至此刻的调用记录快照。 */
  onCallProgress?(event: {
    phase: "start" | "finish";
    name: string;
    args?: unknown;
    status?: "ok" | "error";
    calls: readonly ScriptCall[];
  }): void;
}

export interface CodemodeSandbox {
  run(options: SandboxRunOptions): Promise<SandboxOutcome>;
}

/** worker 入口是 esbuild 构建产物 `worker.js`（prelude 与消息类型已打进去），随仓库提交。 */
function workerUrl(): URL {
  return new URL("worker.js", import.meta.url);
}

const NO_WRITES: StoreWrites = { set: {}, delete: [] };

/** 嵌套调用参数的预览长度：只进进度帧，不进模型上下文。 */
const ARGS_PREVIEW_CHARS = 200;

function previewArgs(args: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    // 跨线程的结构化克隆允许循环引用，JSON.stringify 会抛
    json = undefined;
  }
  return (json ?? "").slice(0, ARGS_PREVIEW_CHARS);
}

/** 注册工具时调用一次：编译 wasm 并返回可复用的沙箱。 */
export async function createCodemodeSandbox(): Promise<CodemodeSandbox> {
  const wasm = await compileQuickJSWasm();
  return {
    run: (options) => runInWorker(wasm, options),
  };
}

function runInWorker(wasm: object, options: SandboxRunOptions): Promise<SandboxOutcome> {
  return new Promise<SandboxOutcome>((resolve) => {
    const worker = new Worker(workerUrl(), { workerData: { wasm } });

    const output: CodemodeOutputItem[] = [];
    const calls: ScriptCall[] = [];
    const started = new Map<number, { name: string; at: number }>();
    let callSequence = 0;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    // 超时与调用方中止合成一条信号，交给嵌套调用：预算到点时正在跑的工具也要停，
    // 否则 terminate 只杀 worker，工具会在主线程继续跑完并留下副作用
    const aborter = new AbortController();
    const signal =
      options.signal === undefined
        ? aborter.signal
        : AbortSignal.any([options.signal, aborter.signal]);

    // 进度帧发出去的是拷贝：记录随后会被改成终态，已经发出去的帧不能被它改掉
    const snapshotCalls = (): ScriptCall[] => calls.map((call) => ({ ...call }));

    const finish = (
      body:
        | { ok: true; value: unknown; writes: StoreWrites }
        | { ok: false; error: ScriptError; writes: StoreWrites },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      void worker.terminate();
      resolve({ ...body, output, calls });
    };

    const fail = (message: string, kind: ScriptError["kind"] = "sandbox"): void => {
      finish({ ok: false, error: { kind, message }, writes: NO_WRITES });
    };

    if (options.signal) {
      if (options.signal.aborted) {
        fail("codemode execution was aborted", "aborted");
        return;
      }
      options.signal.addEventListener(
        "abort",
        () => fail("codemode execution was aborted", "aborted"),
        {
          once: true,
        },
      );
    }

    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs;
      timeoutTimer = setTimeout(() => {
        // 先中止正在跑的嵌套调用，再定结果：terminate 不会自动停主线程里的工具
        aborter.abort();
        fail(`Execution timed out after ${timeoutMs} ms`, "timeout");
      }, timeoutMs);
    }

    const handleCall = async (id: number, name: string, args: unknown): Promise<void> => {
      callSequence += 1;
      const record: ScriptCall = {
        id: `${options.toolCallId}/${callSequence}`,
        name,
        args: previewArgs(args),
        status: "running",
      };
      calls.push(record);
      started.set(id, { name, at: Date.now() });
      // 开始时就带上记录（status=running）：运行期间 UI 就列出调用行，而不是等结果回来才有
      options.onCallProgress?.({ phase: "start", name, args, calls: snapshotCalls() });
      let outcome: SandboxCallOutcome;
      try {
        outcome = await options.onCall({ id, name, args, signal });
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const entry = started.get(id);
      started.delete(id);
      record.status = outcome.ok ? "ok" : "error";
      record.durationMs = entry ? Date.now() - entry.at : 0;
      if (!outcome.ok) {
        record.error = outcome.error;
      }
      options.onCallProgress?.({
        phase: "finish",
        name,
        status: record.status,
        calls: snapshotCalls(),
      });
      if (!settled) {
        worker.postMessage({ t: "result", id, ...outcome });
      }
    };

    const handleMessage = (frame: WorkerMessage): void => {
      if (frame.t === "call") {
        void handleCall(frame.id, frame.name, frame.args);
        return;
      }
      if (frame.t === "output") {
        output.push(...frame.items);
        options.onOutput?.(frame.items);
        return;
      }
      if (frame.ok) {
        finish({ ok: true, value: frame.value, writes: frame.writes });
      } else {
        finish({ ok: false, error: frame.error, writes: frame.writes });
      }
    };

    worker.on("message", (value: unknown) => {
      const decoded = decodeWorkerMessage(value);
      if (!decoded.ok) {
        fail(`codemode worker sent an invalid message (${decoded.error})`);
        return;
      }
      handleMessage(decoded.frame);
    });
    worker.on("error", (error: Error) => fail(`codemode worker failed: ${error.message}`));
    worker.on("exit", (code) => {
      if (!settled) {
        fail(`codemode worker exited early with code ${code}`);
      }
    });

    worker.postMessage({
      t: "start",
      code: options.code,
      tools: [...options.tools],
      store: options.store,
    });
  });
}
