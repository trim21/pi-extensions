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

/** 脚本侧一次嵌套调用的记录（主线程是执行方，所以由它记录）。 */
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

export interface SandboxRunOptions {
  code: string;
  tools: readonly ScriptTool[];
  store: Record<string, unknown>;
  /** 调用方中止本次执行；脚本没有自己的超时，死循环只能靠它结束。 */
  signal?: AbortSignal;
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

/** worker 入口是 esbuild 构建产物 `worker.js`（prelude 与消息类型已打进去），随仓库提交。 */
function workerUrl(): URL {
  return new URL("worker.js", import.meta.url);
}

const NO_WRITES: StoreWrites = { set: {}, delete: [] };

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
    let settled = false;

    const finish = (
      body:
        | { ok: true; value: unknown; writes: StoreWrites }
        | { ok: false; error: ScriptError; writes: StoreWrites },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
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

    const handleCall = async (id: number, name: string, args: unknown): Promise<void> => {
      started.set(id, { name, at: Date.now() });
      options.onCallProgress?.({ phase: "start", name, args });
      let outcome: SandboxCallOutcome;
      try {
        outcome = await options.onCall({ id, name, args });
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const entry = started.get(id);
      started.delete(id);
      calls.push({
        name,
        status: outcome.ok ? "ok" : "error",
        durationMs: entry ? Date.now() - entry.at : 0,
      });
      options.onCallProgress?.({ phase: "finish", name, status: outcome.ok ? "ok" : "error" });
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
