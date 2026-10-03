import { Socket } from "node:net";
const CHANNEL_FD = 3;
const FRAME_MAGIC_BYTE = 30;
const MAGIC = `${String.fromCodePoint(FRAME_MAGIC_BYTE)}PI_CODEMODE${String.fromCodePoint(FRAME_MAGIC_BYTE)}`;
const MAX_HEADER_CHARS = 12;
const MAX_STORE_VALUE_CHARS = 256 * 1024;
const MAX_STORE_TOTAL_CHARS = 1024 * 1024;
const IMAGE_HELPER_EXPECTS = "image expects a non-empty image URL string, an object with image_url, or a raw MCP image block";
class CallFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CallFailedError";
  }
}
class ExitSignal extends Error {
  constructor() {
    super("codemode exit()");
    this.name = "ExitSignal";
  }
}
function errorText(error) {
  if (error instanceof Error) {
    const head = error.message ? `${error.name}: ${error.message}` : error.name;
    const stack = typeof error.stack === "string" ? error.stack.split("\n").slice(1) : [];
    return [head, ...stack].join("\n");
  }
  return String(error);
}
function format(value) {
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
function describeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: errorText(error) };
  }
  return { message: format(error) };
}
function outputText(value) {
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
function serializeJson(value) {
  return JSON.stringify(value);
}
function requireKey(name, key) {
  if (typeof key !== "string") {
    throw new TypeError(`${name}() key must be a string`);
  }
}
function imageUrl(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(IMAGE_HELPER_EXPECTS);
  }
  const block = value;
  if (block.image_url !== void 0) {
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
  const mimeType = typeof block.mimeType === "string" && block.mimeType ? block.mimeType : "application/octet-stream";
  return `data:${mimeType};base64,${block.data}`;
}
function isHostMessage(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const frame = value;
  if (frame.t === "start") {
    return typeof frame.code === "string";
  }
  return frame.t === "result" && typeof frame.id === "number" && typeof frame.ok === "boolean";
}
function main() {
  const channel = new Socket({ fd: CHANNEL_FD, readable: true, writable: true });
  let buffered = Buffer.alloc(0);
  let finished = false;
  let nextId = 1;
  const pending = /* @__PURE__ */ new Map();
  const writes = { set: {}, delete: [] };
  function send(frame) {
    const json = JSON.stringify(frame);
    channel.write(`${MAGIC}${Buffer.byteLength(json, "utf8")}:${json}`);
  }
  function done(ok, payload) {
    if (finished) {
      return;
    }
    finished = true;
    if (ok) {
      send({ t: "done", ok: true, value: payload, writes });
    } else {
      send({ t: "done", ok: false, error: payload, writes });
    }
    channel.unref();
  }
  function emit(items) {
    if (!finished) {
      send({ t: "output", items });
    }
  }
  function text(value) {
    let rendered;
    try {
      rendered = outputText(value);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    emit([{ type: "text", text: rendered }]);
  }
  function image(value) {
    const url = imageUrl(value);
    if (url === "") {
      throw new TypeError(IMAGE_HELPER_EXPECTS);
    }
    const colon = url.indexOf(":");
    const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
    if (scheme === "http" || scheme === "https") {
      throw new TypeError(
        "remote image URLs are not supported in tool outputs. Pass a base64 data URI instead"
      );
    }
    const comma = url.indexOf(",");
    const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
    if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
      throw new TypeError("invalid image output. Pass a base64 data URI instead");
    }
    emit([
      {
        type: "image",
        data: url.slice(comma + 1),
        mimeType: header[0] || "application/octet-stream"
      }
    ]);
  }
  const consoleProxy = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    consoleProxy[level] = (...args) => {
      emit([{ type: "text", text: args.map((arg) => format(arg)).join(" ") }]);
    };
  }
  Object.freeze(consoleProxy);
  function createStore(initial) {
    const stored = /* @__PURE__ */ new Map();
    let storedChars = 0;
    for (const [key, value] of Object.entries(initial)) {
      const json = serializeJson(value);
      if (json === void 0) {
        continue;
      }
      stored.set(key, json);
      storedChars += key.length + json.length;
    }
    return {
      set(key, value) {
        requireKey("store.set", key);
        const previous = stored.has(key) ? key.length + (stored.get(key)?.length ?? 0) : 0;
        if (value === void 0) {
          stored.delete(key);
          storedChars -= previous;
          delete writes.set[key];
          if (!writes.delete.includes(key)) {
            writes.delete.push(key);
          }
          return;
        }
        let json;
        try {
          json = serializeJson(value);
        } catch (error) {
          throw new TypeError(
            `store.set(${JSON.stringify(key)}) value is not JSON-serializable: ${format(error)}`,
            { cause: error }
          );
        }
        if (json === void 0) {
          throw new TypeError(`store.set(${JSON.stringify(key)}) value is not JSON-serializable`);
        }
        if (json.length > MAX_STORE_VALUE_CHARS) {
          throw new RangeError(
            `store.set(${JSON.stringify(key)}) value exceeds ${MAX_STORE_VALUE_CHARS} characters of JSON`
          );
        }
        const next = storedChars - previous + key.length + json.length;
        if (next > MAX_STORE_TOTAL_CHARS) {
          throw new RangeError(
            `store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON`
          );
        }
        stored.set(key, json);
        storedChars = next;
        writes.set[key] = value;
      },
      get(key) {
        requireKey("store.get", key);
        const json = stored.get(key);
        return json === void 0 ? void 0 : JSON.parse(json);
      },
      // 升序返回当前键：上下文压缩后模型可以靠它找回自己写过的名字
      list() {
        return [...stored.keys()].toSorted();
      }
    };
  }
  function toolCaller(name) {
    return (args) => new Promise((resolve, reject) => {
      try {
        serializeJson(args);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ t: "call", id, name, args });
    });
  }
  function settle(id, ok, payload) {
    const entry = pending.get(id);
    if (entry === void 0) {
      return;
    }
    pending.delete(id);
    if (!ok) {
      entry.reject(new CallFailedError(typeof payload === "string" ? payload : format(payload)));
      return;
    }
    entry.resolve(payload);
  }
  async function settleScript(result) {
    try {
      done(true, await result);
    } catch (error) {
      if (!(error instanceof ExitSignal)) {
        done(false, { kind: "script", ...describeError(error) });
      }
    }
  }
  function start(code, tools, initialStore) {
    const callers = /* @__PURE__ */ new Map();
    const allTools = [];
    for (const tool of tools) {
      if (callers.has(tool.name)) {
        continue;
      }
      callers.set(tool.name, toolCaller(tool.name));
      allTools.push(Object.freeze({ name: tool.name, description: tool.description }));
    }
    Object.freeze(allTools);
    const store = Object.freeze(createStore(initialStore));
    function call(name, args) {
      const caller = callers.get(name);
      if (caller === void 0) {
        return Promise.reject(new CallFailedError(`Tool "${name}" is not available in codemode.`));
      }
      return caller(args);
    }
    let factory;
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
        `"use strict";
return (async () => {
${code}
})();
//# sourceURL=codemode-script.js`
      );
    } catch (error) {
      done(false, { kind: "script", ...describeError(error) });
      return;
    }
    let result;
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
        consoleProxy
      );
    } catch (error) {
      if (!(error instanceof ExitSignal)) {
        done(false, { kind: "script", ...describeError(error) });
      }
      return;
    }
    void settleScript(result);
  }
  function handleFrame(frame) {
    if (finished) {
      return;
    }
    if (frame.t === "start") {
      start(frame.code, frame.tools, frame.store);
      return;
    }
    settle(frame.id, frame.ok, frame.ok ? frame.value : frame.error);
  }
  function parseChunk() {
    for (; ; ) {
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
      const colonAt = afterMagic.indexOf(58);
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
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      if (isHostMessage(parsed)) {
        handleFrame(parsed);
      }
    }
  }
  channel.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    parseChunk();
  });
  channel.on("close", () => {
    process.exit(0);
  });
  channel.on("error", () => {
    process.exit(1);
  });
  send({ t: "ready" });
}
main();
