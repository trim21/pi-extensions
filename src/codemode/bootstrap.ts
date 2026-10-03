/* eslint-disable @typescript-eslint/no-implied-eval, unicorn/no-process-exit -- 脚本本体就是一个函数体，必须经 Function 构造器编译成异步函数（全局能力与子进程完全相同）；这个文件是独立的子进程入口，按退出码结束进程是正确的收尾方式 */
/**
 * codemode 脚本子进程的入口：由宿主用 `bwrap … node bootstrap.js` 起在沙箱里，
 * 每次执行一个进程，跑完即被回收。产物 `bootstrap.js` 由 `pnpm run build:codemode-bootstrap`
 * 生成并随仓库提交（pre-commit 会重新生成）。
 *
 * 它跑在 pi 进程之外，由 `node` 直接加载，不走 pi 的 jiti 加载器，因此解析不到 pi 提供的
 * 依赖（`worker.js` 那个 `typebox` 事故的根因）。所以这个文件只允许两种 import：
 * `node:` 内置模块，以及 `./protocol.js` 的**类型**（类型导入在转译后完全消失，不带任何
 * 运行期依赖）。回归测试 `test/codemode.test.ts` 的「bootstrap 脚本产物」会检查这一点。
 *
 * 通信：与宿主共用一条专用 fd（spawn 建的 socketpair，本来就是全双工，见 `CHANNEL_FD`）。
 * 两个方向的分帧一致：magic + 十进制长度 + `:` + JSON 文本；宿主发 `start` / `result`，
 * 这里发 `ready` / `call` / `output` / `done`。**stdin/stdout/stderr 完全不参与协议**：
 * stdin 是 /dev/null，stdout/stderr 是脚本自己的输出（宿主收集成脚本输出项），脚本或它用的
 * 库往那里写什么都破坏不了协议。
 *
 * 脚本本体是一个 async 函数体：`new Function` 把注入的接口作为参数传进去，顶层 `await` 与
 * `return` 都可用；其余能力（`node:fs`、`process`、`setTimeout` …）来自 Node 本身，边界由
 * 宿主给的沙箱配置决定，这个小程序不做额外的权限裁剪。
 *
 * 状态都在 `main()` 的闭包里：这是一个一次性的单次执行进程，跑完即退出。
 */

import { Socket } from "node:net";

import type {
  ChildMessage,
  CodemodeOutputItem,
  HostMessage,
  ScriptError,
  ScriptTool,
  StoreWrites,
} from "./protocol.js";

/** 协议 fd：stdin/stdout/stderr 之外的那条全双工 socketpair。 */
const CHANNEL_FD = 3;
/**
 * 帧起始标记。用 ASCII 控制字符 0x1e 包住：脚本往协议 fd 写普通文本时几乎不可能凑出它，
 * 因而不会把脚本文本当帧解析。写成 `fromCodePoint` 是为了让转译产物里也不出现裸控制字符
 * （宿主侧 `protocol.ts` 用同一段构造，两边必须一致）。
 */
const FRAME_MAGIC_BYTE = 0x1e;
const MAGIC = `${String.fromCodePoint(FRAME_MAGIC_BYTE)}PI_CODEMODE${String.fromCodePoint(FRAME_MAGIC_BYTE)}`;
/** 帧头的最大长度（magic 之后的十进制长度 + 冒号），超过即判定是杂散字节。 */
const MAX_HEADER_CHARS = 12;
/** `store.set()` 单个值的 JSON 上限（字符数）。 */
const MAX_STORE_VALUE_CHARS = 256 * 1024;
/** 全部 store 值的 JSON 上限（字符数）。 */
const MAX_STORE_TOTAL_CHARS = 1024 * 1024;
const STALL_CHECK_INTERVAL_MS = 250;
const IMAGE_HELPER_EXPECTS =
  "image expects a non-empty image URL string, an object with image_url, or a raw MCP image block";

/** 脚本调用工具失败时 reject 的错误：脚本按 `instanceof CallFailedError` 判别。 */
class CallFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallFailedError";
  }
}

/** `exit()` 用它解开脚本栈：成功结果已经报过了。 */
class ExitSignal extends Error {
  constructor() {
    super("codemode exit()");
    this.name = "ExitSignal";
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const head = error.message ? `${error.name}: ${error.message}` : error.name;
    const stack = typeof error.stack === "string" ? error.stack.split("\n").slice(1) : [];
    return [head, ...stack].join("\n");
  }
  return String(error);
}

function format(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return errorText(value);
  }
  try {
    const json = serializeJson(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function describeError(error: unknown): Partial<ScriptError> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: errorText(error) };
  }
  return { message: format(error) };
}

/** `text()` 的渲染：对象/数组做成 JSON，其它走 String()。 */
function outputText(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return typeof value === "function" ? `[Function ${value.name}]` : String(value);
  }
  try {
    const json = serializeJson(value);
    return json ?? "[object Object]";
  } catch {
    return "[object Object]";
  }
}

/**
 * `JSON.stringify` 的运行期返回类型其实是 `string | undefined`（函数、symbol、undefined
 * 都会得到 undefined），lib 的类型没这么写。这个包装让调用方按运行期事实处理。
 */
function serializeJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/** `store.*` 的 key 必须是字符串。 */
function requireKey(name: string, key: unknown): asserts key is string {
  if (typeof key !== "string") {
    throw new TypeError(`${name}() key must be a string`);
  }
}

/** `image()` 接受的输入：图像 URL 字符串 / `{ image_url }` / MCP image block。 */
function imageUrl(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(IMAGE_HELPER_EXPECTS);
  }
  const block = value as Record<string, unknown>;
  if (block.image_url !== undefined) {
    if (typeof block.image_url !== "string") {
      throw new TypeError(IMAGE_HELPER_EXPECTS);
    }
    return block.image_url;
  }
  if (typeof block.type !== "string") {
    throw new TypeError(IMAGE_HELPER_EXPECTS);
  }
  if (block.type !== "image") {
    throw new TypeError(`image only accepts MCP image blocks, got "${block.type}"`);
  }
  if (typeof block.data !== "string" || block.data === "") {
    throw new TypeError("image expected MCP image data");
  }
  if (block.data.toLowerCase().startsWith("data:")) {
    return block.data;
  }
  const mimeType =
    typeof block.mimeType === "string" && block.mimeType
      ? block.mimeType
      : "application/octet-stream";
  return `data:${mimeType};base64,${block.data}`;
}

/** 宿主帧的形状检查：只认自己发出去的两种帧（宿主是可信方，这里不做完整校验）。 */
function isHostMessage(value: unknown): value is HostMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const frame = value as Record<string, unknown>;
  if (frame.t === "start") {
    return typeof frame.code === "string";
  }
  return frame.t === "result" && typeof frame.id === "number" && typeof frame.ok === "boolean";
}

function main(): void {
  const channel = new Socket({ fd: CHANNEL_FD, readable: true, writable: true });
  let buffered = Buffer.alloc(0);
  let finished = false;
  let inflight = 0;
  let stopStallWatch: (() => void) | undefined;
  let nextId = 1;
  /** 在飞的嵌套调用：宿主回帧时按 id settle。 */
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  /** store 的写入：`delete` 是 `set(key, undefined)` 的删除，`set` 是覆写的键值。 */
  const writes: StoreWrites = { set: {}, delete: [] };

  function send(frame: ChildMessage): void {
    const json = JSON.stringify(frame);
    channel.write(`${MAGIC}${Buffer.byteLength(json, "utf8")}:${json}`);
  }

  /**
   * 结束这一轮：`done` 只报一次。之后不再需要这条通道（unref），事件循环里只剩脚本自己的
   * 输出在冲管道，冲完进程自然退出——宿主等进程结束再收尾，因此不会丢 stdout/stderr。
   */
  function done(ok: boolean, payload?: unknown): void {
    if (finished) {
      return;
    }
    finished = true;
    stopStallWatch?.();
    if (ok) {
      send({ t: "done", ok: true, value: payload, writes });
    } else {
      send({ t: "done", ok: false, error: payload as ScriptError, writes });
    }
    channel.unref();
  }

  function emit(items: CodemodeOutputItem[]): void {
    if (!finished) {
      send({ t: "output", items });
    }
  }

  function text(value: unknown): void {
    let rendered: string;
    try {
      rendered = outputText(value);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    emit([{ type: "text", text: rendered }]);
  }

  function image(value: unknown): void {
    const url = imageUrl(value);
    if (url === "") {
      throw new TypeError(IMAGE_HELPER_EXPECTS);
    }
    const colon = url.indexOf(":");
    const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
    if (scheme === "http" || scheme === "https") {
      throw new TypeError(
        "remote image URLs are not supported in tool outputs. Pass a base64 data URI instead",
      );
    }
    const comma = url.indexOf(",");
    const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
    if (
      scheme !== "data" ||
      comma === -1 ||
      header.slice(1).every((part) => part.toLowerCase() !== "base64")
    ) {
      throw new TypeError("invalid image output. Pass a base64 data URI instead");
    }
    emit([
      {
        type: "image",
        data: url.slice(comma + 1),
        mimeType: header[0] || "application/octet-stream",
      },
    ]);
  }

  /**
   * 脚本侧的 `console`：输出走协议帧，因此与 `text()` 的输出严格同序（直接写 stdout 的内容
   * 由宿主收集，可能排在这些之后）。脚本仍可以用 `process.stdout.write`，那就是另一条路。
   */
  const consoleProxy: Record<string, (...args: unknown[]) => void> = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    consoleProxy[level] = (...args: unknown[]) => {
      emit([{ type: "text", text: args.map((arg) => format(arg)).join(" ") }]);
    };
  }
  Object.freeze(consoleProxy);

  /** 脚本侧的 store：数据留在闭包里，宿主只看到本次的写入（随工具结果持久化）。 */
  function createStore(initial: Record<string, unknown>): {
    set(key: string, value: unknown): void;
    get(key: string): unknown;
    list(): string[];
  } {
    const stored = new Map<string, string>();
    let storedChars = 0;
    for (const [key, value] of Object.entries(initial)) {
      const json = serializeJson(value);
      if (json === undefined) {
        continue;
      }
      stored.set(key, json);
      storedChars += key.length + json.length;
    }

    return {
      set(key: string, value: unknown): void {
        requireKey("store.set", key);
        const previous = stored.has(key) ? key.length + (stored.get(key)?.length ?? 0) : 0;
        if (value === undefined) {
          stored.delete(key);
          storedChars -= previous;
          delete writes.set[key];
          if (!writes.delete.includes(key)) {
            writes.delete.push(key);
          }
          return;
        }
        let json: string | undefined;
        try {
          json = serializeJson(value);
        } catch (error) {
          throw new TypeError(
            `store.set(${JSON.stringify(key)}) value is not JSON-serializable: ${format(error)}`,
            { cause: error },
          );
        }
        if (json === undefined) {
          throw new TypeError(`store.set(${JSON.stringify(key)}) value is not JSON-serializable`);
        }
        if (json.length > MAX_STORE_VALUE_CHARS) {
          throw new RangeError(
            `store.set(${JSON.stringify(key)}) value exceeds ${MAX_STORE_VALUE_CHARS} characters of JSON`,
          );
        }
        const next = storedChars - previous + key.length + json.length;
        if (next > MAX_STORE_TOTAL_CHARS) {
          throw new RangeError(
            `store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON`,
          );
        }
        stored.set(key, json);
        storedChars = next;
        writes.set[key] = value;
      },
      get(key: string): unknown {
        requireKey("store.get", key);
        const json = stored.get(key);
        return json === undefined ? undefined : (JSON.parse(json) as unknown);
      },
      // 升序返回当前键：上下文压缩后模型可以靠它找回自己写过的名字
      list(): string[] {
        return [...stored.keys()].toSorted();
      },
    };
  }

  /**
   * 卡死检测：脚本既没有在飞的嵌套调用、又没有挂起的异步资源时，那个从不 settle 的
   * promise 永远不会被唤醒（真 Node 里有 timer，宿主端没法判断，子进程自己可以）。
   * 基线在脚本开始前取，因为我们自己的轮询 timer 也在资源列表里。
   */
  function startStallWatch(baseline: readonly string[]): () => void {
    const timer = setInterval(() => {
      if (finished || inflight > 0) {
        return;
      }
      const counts = new Map<string, number>();
      for (const name of baseline) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const extra: string[] = [];
      for (const name of process.getActiveResourcesInfo()) {
        const remaining = counts.get(name) ?? 0;
        if (remaining > 0) {
          counts.set(name, remaining - 1);
        } else {
          extra.push(name);
        }
      }
      // 差集里只剩我们自己的轮询 timer：脚本没有任何能唤醒它的东西
      if (extra.length === 1 && extra[0] === "Timeout") {
        done(false, {
          kind: "script",
          name: "Error",
          message:
            "The script is waiting on a promise that can never settle: no tool call is pending, and nothing else is pending in the runtime.",
        });
      }
    }, STALL_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }

  function toolCaller(name: string): (args: unknown) => Promise<unknown> {
    return (args) =>
      new Promise((resolve, reject) => {
        // 先确认参数能过 JSON：不能过就在脚本内报错，不必打扰宿主
        try {
          serializeJson(args);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        inflight += 1;
        send({ t: "call", id, name, args });
      });
  }

  function settle(id: number, ok: boolean, payload: unknown): void {
    const entry = pending.get(id);
    if (entry === undefined) {
      return;
    }
    pending.delete(id);
    inflight -= 1;
    if (!ok) {
      entry.reject(new CallFailedError(typeof payload === "string" ? payload : format(payload)));
      return;
    }
    entry.resolve(payload);
  }

  /** 等脚本的返回值 settle 后收尾（用 await 而不是 `.then`，避免把收尾写成 promise 回调）。 */
  async function settleScript(result: Promise<unknown>): Promise<void> {
    try {
      done(true, await result);
    } catch (error) {
      if (!(error instanceof ExitSignal)) {
        done(false, { kind: "script", ...describeError(error) });
      }
    }
  }

  function start(code: string, tools: ScriptTool[], initialStore: Record<string, unknown>): void {
    const callers = new Map<string, (args: unknown) => Promise<unknown>>();
    const allTools: { name: string; description?: string }[] = [];
    for (const tool of tools) {
      if (callers.has(tool.name)) {
        continue;
      }
      callers.set(tool.name, toolCaller(tool.name));
      allTools.push(Object.freeze({ name: tool.name, description: tool.description }));
    }
    Object.freeze(allTools);

    const store = Object.freeze(createStore(initialStore));

    function call(name: string, args?: unknown): Promise<unknown> {
      const caller = callers.get(name);
      if (caller === undefined) {
        return Promise.reject(new CallFailedError(`Tool "${name}" is not available in codemode.`));
      }
      return caller(args);
    }

    let factory: (...injected: unknown[]) => Promise<unknown>;
    try {
      factory = new Function(
        "call",
        "CallFailedError",
        "ALL_TOOLS",
        "text",
        "image",
        "exit",
        "store",
        "console",
        `"use strict";\nreturn (async () => {\n${code}\n})();\n//# sourceURL=codemode-script.js`,
      ) as (...injected: unknown[]) => Promise<unknown>;
    } catch (error) {
      // 语法错误：脚本没跑起来，也没有任何调用发生
      done(false, { kind: "script", ...describeError(error) });
      return;
    }

    stopStallWatch = startStallWatch(process.getActiveResourcesInfo());

    let result: Promise<unknown>;
    try {
      result = factory(
        call,
        CallFailedError,
        allTools,
        text,
        image,
        () => {
          done(true);
          throw new ExitSignal();
        },
        store,
        consoleProxy,
      );
    } catch (error) {
      if (!(error instanceof ExitSignal)) {
        done(false, { kind: "script", ...describeError(error) });
      }
      return;
    }

    void settleScript(result);
  }

  function handleFrame(frame: HostMessage): void {
    if (finished) {
      return;
    }
    if (frame.t === "start") {
      start(frame.code, frame.tools, frame.store);
      return;
    }
    settle(frame.id, frame.ok, frame.ok ? frame.value : frame.error);
  }

  /** 增量帧解析：与宿主侧同一套分帧，magic 之前允许杂散字节（重新同步即可）。 */
  function parseChunk(): void {
    for (;;) {
      const magicAt = buffered.indexOf(MAGIC);
      if (magicAt === -1) {
        const keep = MAGIC.length - 1;
        if (buffered.length > keep) {
          buffered = buffered.subarray(buffered.length - keep);
        }
        return;
      }
      if (magicAt > 0) {
        buffered = buffered.subarray(magicAt);
      }
      const afterMagic = buffered.subarray(MAGIC.length);
      const colonAt = afterMagic.indexOf(0x3a);
      if (colonAt === -1) {
        if (afterMagic.length > MAX_HEADER_CHARS) {
          buffered = buffered.subarray(MAGIC.length);
          continue;
        }
        return;
      }
      const lengthText = afterMagic.subarray(0, colonAt).toString("ascii");
      const length = /^\d+$/.test(lengthText) ? Number(lengthText) : NaN;
      if (!Number.isSafeInteger(length)) {
        buffered = buffered.subarray(MAGIC.length);
        continue;
      }
      const bodyAt = MAGIC.length + colonAt + 1;
      if (buffered.length < bodyAt + length) {
        return;
      }
      const body = buffered.subarray(bodyAt, bodyAt + length).toString("utf8");
      buffered = buffered.subarray(bodyAt + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        continue;
      }
      if (isHostMessage(parsed)) {
        handleFrame(parsed);
      }
    }
  }

  channel.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    parseChunk();
  });

  // 宿主关掉通道（执行被中止或宿主退出）：没有可等的结果，直接结束
  channel.on("close", () => {
    process.exit(0);
  });
  channel.on("error", () => {
    process.exit(1);
  });

  send({ t: "ready" });
}

main();
