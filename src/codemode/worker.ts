/**
 * codemode 的 worker 线程入口：一次执行一个 worker，跑完或被 `terminate()` 结束。
 *
 * 为什么用 worker 而不是主线程：脚本是模型写的、可能死循环，只有 worker 能被
 * `terminate()` 干净地丢掉（连同它那份 wasm 实例）。wasm 模块在主线程注册时编译好，
 * 经 workerData 结构化克隆传进来——模块可以跨线程传，编译结果不必重复付出。
 *
 * 线程内只有一个 QuickJS VM：没有 node、没有文件、没有网络、没有 timer，脚本唯一的
 * 能力是调用注入的工具，而工具由主线程执行。
 */

import { parentPort, workerData } from "node:worker_threads";

import { JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";

import { isRecord } from "../lib/narrow.js";
import { PRELUDE_SOURCE } from "./prelude.js";
import {
  type HostMessage,
  MEMORY_LIMIT_BYTES,
  type ScriptError,
  type StoreWrites,
  type WorkerBootstrap,
  type WorkerMessage,
} from "./protocol.js";

/**
 * QuickJS 把引擎诊断写到 fd 1 / 2，那会直接进 pi 的 TUI；按写入长度回报并丢弃内容，
 * 避免 libc 重试。
 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
  return {
    fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const view = new DataView(memory.buffer);
      let written = 0;
      for (let index = 0; index < iovsLen; index++) {
        written += view.getUint32(iovsPtr + index * 8 + 4, true);
      }
      view.setUint32(nwrittenPtr, written, true);
      return 0;
    },
  };
}

function post(message: WorkerMessage): void {
  parentPort?.postMessage(message);
}

/**
 * 主线程发来的消息由主线程自己构造，形状由 `HostMessage` 类型约束，所以这里只做分派、
 * 不重复 typebox 校验；但形状对不上就是内部 bug，得报错而不是静默丢弃——静默丢弃只会
 * 让脚本永远等在 pending 上，症状比故障本身难查得多。
 */
function isResultMessage(value: unknown): value is Extract<HostMessage, { t: "result" }> {
  return isRecord(value) && value.t === "result" && typeof value.id === "number";
}

function isStartMessage(value: unknown): value is Extract<HostMessage, { t: "start" }> {
  return isRecord(value) && value.t === "start";
}

/** 畸形消息的预览：截断成一行，序列化不了（循环引用、undefined 等）就退化成 String()。 */
function previewMessage(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value);
  }
}

function emptyWrites(): StoreWrites {
  return { set: {}, delete: [] };
}

/** prelude 传来的 writes 是 `[[key, json?], ...]`。 */
function parseWrites(json: string): StoreWrites {
  try {
    const entries = JSON.parse(json) as [string, string?][];
    const writes: StoreWrites = { set: {}, delete: [] };
    for (const [key, value] of entries) {
      if (value === undefined) {
        writes.delete.push(key);
      } else {
        writes.set[key] = JSON.parse(value) as unknown;
      }
    }
    return writes;
  } catch {
    return emptyWrites();
  }
}

/** 把 prelude 的 error 描述 JSON 转成可上报的错误。 */
function scriptError(payload: string | undefined): ScriptError {
  if (payload === undefined) {
    return { kind: "script", message: "the script failed without an error message" };
  }
  try {
    const parsed = JSON.parse(payload) as { name?: string; message?: string; stack?: string };
    return {
      kind: "script",
      name: parsed.name,
      message: parsed.message ?? payload,
      stack: parsed.stack,
    };
  } catch {
    return { kind: "script", message: payload };
  }
}

async function runScript(wasm: object, start: Extract<HostMessage, { t: "start" }>): Promise<void> {
  const port = parentPort;
  if (!port) {
    return;
  }

  const vm = await QuickJS.create({
    wasm,
    memoryLimit: MEMORY_LIMIT_BYTES,
    // 没有这个上限时深递归会打穿 wasm 栈变成 trap，而不是脚本里可捕获的 RangeError
    maxStackSize: MAX_STACK_SIZE,
    wasi: discardOutput,
  });

  // prelude 只传原始值过桥：kind 是字符串，其余按需从字符串解析
  const bridge = vm.newFunction(
    "bridge",
    (
      kind: JSValueHandle,
      a: JSValueHandle,
      b: JSValueHandle | undefined,
      c: JSValueHandle | undefined,
    ) => {
      const stringOr = (value: JSValueHandle | undefined, fallback: string): string =>
        value === undefined || value.isUndefined ? fallback : value.toString();
      const numberOr = (value: JSValueHandle | undefined, fallback: number): number =>
        value === undefined || value.isUndefined ? fallback : value.toNumber();
      switch (kind.toString()) {
        case "call": {
          post({
            t: "call",
            id: a.toNumber(),
            name: stringOr(b, ""),
            args:
              c === undefined || c.isUndefined ? undefined : (JSON.parse(c.toString()) as unknown),
          });
          break;
        }
        case "output": {
          post({
            t: "output",
            items:
              a.toString() === "image"
                ? [
                    {
                      type: "image",
                      data: stringOr(b, ""),
                      mimeType: stringOr(c, "application/octet-stream"),
                    },
                  ]
                : [{ type: "text", text: stringOr(b, "") }],
          });
          break;
        }
        case "sleep": {
          // 用 worker 线程自己的定时器：不经主线程，也没有消息往返
          const id = a.toNumber();
          const ms = numberOr(b, 0);
          setTimeout(() => {
            try {
              vm.withScope(() => {
                vm.callFunction(timerDone, api, vm.newNumber(id)).dispose();
              });
            } catch {
              /* VM 已中止 */
            }
            drain();
          }, ms);
          break;
        }
        case "done": {
          const writes =
            c === undefined || c.isUndefined ? emptyWrites() : parseWrites(c.toString());
          if (a.toBoolean()) {
            post({
              t: "done",
              ok: true,
              value:
                b === undefined || b.isUndefined
                  ? undefined
                  : (JSON.parse(b.toString()) as unknown),
              writes,
            });
          } else {
            post({
              t: "done",
              ok: false,
              error: scriptError(b === undefined ? undefined : b.toString()),
              writes,
            });
          }
          break;
        }
      }
      return vm.undefined;
    },
  );

  const api = vm.withScope((scope) =>
    scope.escape(
      vm.callFunction(
        vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
        vm.undefined,
        bridge,
        vm.newString(
          JSON.stringify(
            start.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              structuredSchema: tool.structuredSchema,
            })),
          ),
        ),
        vm.newString(JSON.stringify(start.store)),
      ),
    ),
  );
  const settle = api.getProp("settle");
  const timerDone = api.getProp("timerDone");
  const run = api.getProp("run");
  const stalled = api.getProp("stalled");

  /** 跑完排队的 job，再判定「等一个永远不会 settle 的 promise」。 */
  const drain = (): void => {
    vm.executePendingJobs();
    vm.callFunction(stalled, api).dispose();
  };

  port.on("message", (value: unknown) => {
    if (!isResultMessage(value)) {
      // 主线程只会发 result：对不上就是宿主自己的 bug，报出去而不是静默让脚本挂住
      post({
        t: "done",
        ok: false,
        error: {
          kind: "sandbox",
          message: `codemode worker: unexpected host message: ${previewMessage(value)}`,
        },
        writes: emptyWrites(),
      });
      return;
    }
    try {
      vm.withScope(() => {
        vm.callFunction(
          settle,
          api,
          vm.newNumber(value.id),
          value.ok ? vm.true : vm.false,
          value.ok
            ? value.value === undefined
              ? vm.undefined
              : vm.newString(JSON.stringify(value.value))
            : vm.newString(value.error),
        );
      });
    } catch {
      /* VM 已中止 */
    }
    drain();
  });

  try {
    // 前缀与脚本首行共用一行，报错行号与用户写的脚本一致
    const fn: JSValueHandle = vm.evalCode(`(async () => {${start.code}\n})`, "codemode.js");
    vm.callFunction(run, api, fn).dispose();
    fn.dispose();
    drain();
  } catch (error) {
    if (error instanceof JSException) {
      post({
        t: "done",
        ok: false,
        error: scriptError(
          JSON.stringify({ name: error.name, message: error.message, stack: error.stack }),
        ),
        writes: emptyWrites(),
      });
    } else {
      post({
        t: "done",
        ok: false,
        error: { kind: "sandbox", message: error instanceof Error ? error.message : String(error) },
        writes: emptyWrites(),
      });
    }
  }
}

function main(): void {
  const port = parentPort;
  if (!port) {
    return;
  }
  const { wasm } = workerData as WorkerBootstrap;
  // 主线程先发 start；worker 收到后才实例化 VM（wasm 已在主线程编译好）
  port.once("message", (value: unknown) => {
    if (!isStartMessage(value)) {
      post({
        t: "done",
        ok: false,
        error: { kind: "sandbox", message: "codemode worker: expected a start message first" },
        writes: emptyWrites(),
      });
      return;
    }
    void runScript(wasm, value);
  });
}

main();
