// src/codemode/worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { JSException, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";

// src/codemode/prelude.ts
var MAX_STORE_VALUE_CHARS = 256 * 1024;
var MAX_STORE_TOTAL_CHARS = 1024 * 1024;
var IMAGE_HELPER_EXPECTS = "image expects a non-empty image URL string, an object with image_url, or a raw MCP image block";
var PRELUDE_SOURCE = String.raw`(function (bridge, toolsJson, storeJson) {
	"use strict";
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const promiseThen = Promise.prototype.then;
	const ErrorCtor = Error;
	const TypeErrorCtor = TypeError;
	const pending = new Map();
	let nextId = 1;
	let finished = false;
	// exit() 用它解开脚本栈：成功结果已经报过了。
	const EXIT = Object.freeze({});

	function done(ok, payload, writes) {
		if (finished) return;
		finished = true;
		bridge("done", ok, payload, writes);
	}

	function serialize(value) {
		return value === undefined ? undefined : stringify(value);
	}

	// QuickJS 的 stack 只有帧，没有 "Name: message" 头；补上并去掉本 prelude 的帧，
	// 读起来与 Node 的报错一致。
	function errorText(error) {
		const head = error.message ? error.name + ": " + error.message : String(error.name);
		const frames =
			typeof error.stack === "string"
				? error.stack.split("\n").filter((line) => line.trim() && !line.includes("codemode-prelude.js"))
				: [];
		return [head, ...frames].join("\n");
	}

	function format(value) {
		if (typeof value === "string") return value;
		if (value instanceof ErrorCtor) return errorText(value);
		try {
			const json = stringify(value);
			return json === undefined ? String(value) : json;
		} catch {
			return String(value);
		}
	}

	function describeError(error) {
		if (error instanceof ErrorCtor) {
			return stringify({ name: error.name, message: error.message, stack: errorText(error) });
		}
		return stringify({ message: format(error) });
	}

	function caller(name) {
		return (args) =>
			new Promise((resolve, reject) => {
				let json;
				try {
					json = serialize(args);
				} catch (error) {
					reject(error);
					return;
				}
				const id = nextId++;
				pending.set(id, { resolve, reject });
				bridge("call", id, name, json);
			});
	}

	const tools = Object.create(null);
	const allTools = [];
	for (const { name, jsName, description } of parse(toolsJson)) {
		const fn = caller(name);
		// 两个名字归一化成同一个标识符时，第一个赢
		if (!(jsName in tools)) {
			tools[jsName] = fn;
			allTools.push(Object.freeze({ name: jsName, description }));
		}
		if (!(name in tools)) tools[name] = fn;
	}
	Object.freeze(tools);
	Object.freeze(allTools);

	// key -> JSON 文本；容量按 key 与 JSON 的字符数计
	const stored = new Map(Object.entries(parse(storeJson)));
	const writes = new Map();
	let storedChars = 0;
	for (const [key, json] of stored) storedChars += key.length + json.length;

	function checkKey(name, key) {
		if (typeof key !== "string") throw new TypeErrorCtor(name + "() key must be a string");
	}

	function store(key, value) {
		checkKey("store", key);
		const previous = stored.has(key) ? key.length + stored.get(key).length : 0;
		if (value === undefined) {
			stored.delete(key);
			storedChars -= previous;
			writes.set(key, undefined);
			return;
		}
		let json;
		try {
			json = stringify(value);
		} catch (error) {
			throw new TypeErrorCtor("store(" + stringify(key) + ") value is not JSON-serializable: " + format(error));
		}
		if (json === undefined) {
			throw new TypeErrorCtor("store(" + stringify(key) + ") value is not JSON-serializable");
		}
		if (json.length > ${MAX_STORE_VALUE_CHARS}) {
			throw new RangeError("store(" + stringify(key) + ") value exceeds ${MAX_STORE_VALUE_CHARS} characters of JSON");
		}
		const next = storedChars - previous + key.length + json.length;
		if (next > ${MAX_STORE_TOTAL_CHARS}) {
			throw new RangeError("store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON");
		}
		stored.set(key, json);
		storedChars = next;
		writes.set(key, json);
	}

	function load(key) {
		checkKey("load", key);
		const json = stored.get(key);
		return json === undefined ? undefined : parse(json);
	}

	function serializeWrites() {
		const entries = [];
		for (const [key, json] of writes) entries.push(json === undefined ? [key] : [key, json]);
		return stringify(entries);
	}

	Object.defineProperty(globalThis, "store", { value: store, enumerable: true });
	Object.defineProperty(globalThis, "load", { value: load, enumerable: true });

	// 原始值转字符串，其余 JSON 化
	function outputText(value) {
		if (value === undefined || value === null || (typeof value !== "object" && typeof value !== "function")) {
			return String(value);
		}
		const json = stringify(value);
		return json === undefined ? String(value) : json;
	}

	function text(value) {
		let rendered;
		try {
			rendered = outputText(value);
		} catch (error) {
			throw new TypeErrorCtor(error instanceof ErrorCtor ? error.message : String(error));
		}
		if (!finished) bridge("output", "text", rendered);
	}

	function imageUrl(value) {
		if (typeof value === "string") return value;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		}
		if (value.image_url !== undefined) {
			if (typeof value.image_url !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
			return value.image_url;
		}
		if (typeof value.type !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		if (value.type !== "image") {
			throw new TypeErrorCtor('image only accepts MCP image blocks, got "' + value.type + '"');
		}
		if (typeof value.data !== "string" || value.data === "") throw new TypeErrorCtor("image expected MCP image data");
		if (value.data.toLowerCase().startsWith("data:")) return value.data;
		const mimeType = typeof value.mimeType === "string" && value.mimeType ? value.mimeType : "application/octet-stream";
		return "data:" + mimeType + ";base64," + value.data;
	}

	function image(value) {
		const url = imageUrl(value);
		if (url === "") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		const colon = url.indexOf(":");
		const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
		if (scheme === "http" || scheme === "https") {
			throw new TypeErrorCtor("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead");
		}
		const comma = url.indexOf(",");
		const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
		if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
			throw new TypeErrorCtor("invalid image output. Pass a base64 data URI instead");
		}
		if (!finished) bridge("output", "image", url.slice(comma + 1), header[0] || "application/octet-stream");
	}

	function exit() {
		let writesJson;
		try {
			writesJson = serializeWrites();
		} catch (error) {
			done(false, describeError(error));
			throw EXIT;
		}
		done(true, undefined, writesJson);
		throw EXIT;
	}

	const console = {};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		console[level] = (...args) => {
			if (!finished) bridge("output", "text", args.map(format).join(" "));
		};
	}
	Object.freeze(console);

	Object.defineProperty(globalThis, "tools", { value: tools, enumerable: true });
	Object.defineProperty(globalThis, "ALL_TOOLS", { value: allTools, enumerable: true });
	Object.defineProperty(globalThis, "console", { value: console, enumerable: true });
	Object.defineProperty(globalThis, "text", { value: text, enumerable: true });
	Object.defineProperty(globalThis, "image", { value: image, enumerable: true });
	Object.defineProperty(globalThis, "exit", { value: exit, enumerable: true });

	return {
		settle(id, ok, payload) {
			const entry = pending.get(id);
			if (!entry) return;
			pending.delete(id);
			if (!ok) {
				entry.reject(new ErrorCtor(payload));
				return;
			}
			let value;
			try {
				value = payload === undefined ? undefined : parse(payload);
			} catch (error) {
				entry.reject(error);
				return;
			}
			entry.resolve(value);
		},
		run(fn) {
			let promise;
			try {
				promise = fn(tools, console);
			} catch (error) {
				done(false, describeError(error));
				return;
			}
			promiseThen.call(
				promise,
				(value) => {
					let json;
					try {
						json = serialize(value);
					} catch (error) {
						done(false, describeError(error));
						return;
					}
					done(true, json, serializeWrites());
				},
				(error) => {
					done(false, describeError(error));
				},
			);
		},
		stalled() {
			if (finished || pending.size > 0) return false;
			done(
				false,
				stringify({
					name: "Error",
					message:
						"The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here.",
				}),
			);
			return true;
		},
	};
})`;

// src/codemode/protocol.ts
import { Type } from "typebox";
import { Value } from "typebox/value";
var outputItemSchema = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() })
]);
var toolDeclSchema = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.String())
});
var startSchema = Type.Object({
  t: Type.Literal("start"),
  code: Type.String(),
  tools: Type.Array(toolDeclSchema),
  store: Type.Record(Type.String(), Type.Unknown())
});
var resultSchema = Type.Union([
  Type.Object({
    t: Type.Literal("result"),
    id: Type.Number(),
    ok: Type.Literal(true),
    value: Type.Unknown()
  }),
  Type.Object({
    t: Type.Literal("result"),
    id: Type.Number(),
    ok: Type.Literal(false),
    error: Type.String()
  })
]);
var callSchema = Type.Object({
  t: Type.Literal("call"),
  id: Type.Number(),
  name: Type.String(),
  args: Type.Unknown()
});
var outputSchema = Type.Object({
  t: Type.Literal("output"),
  items: Type.Array(outputItemSchema)
});
var scriptErrorSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("script"),
    Type.Literal("timeout"),
    Type.Literal("aborted"),
    Type.Literal("sandbox")
  ]),
  name: Type.Optional(Type.String()),
  message: Type.String(),
  stack: Type.Optional(Type.String())
});
var storeWritesSchema = Type.Object({
  set: Type.Record(Type.String(), Type.Unknown()),
  delete: Type.Array(Type.String())
});
var doneSchema = Type.Union([
  Type.Object({
    t: Type.Literal("done"),
    ok: Type.Literal(true),
    value: Type.Unknown(),
    writes: storeWritesSchema
  }),
  Type.Object({
    t: Type.Literal("done"),
    ok: Type.Literal(false),
    error: scriptErrorSchema,
    writes: storeWritesSchema
  })
]);
var hostMessageSchema = Type.Union([startSchema, resultSchema]);
var workerMessageSchema = Type.Union([callSchema, outputSchema, doneSchema]);
function decode(schema, value) {
  if (!Value.Check(schema, value)) {
    const preview = JSON.stringify(value).slice(0, 200);
    return { ok: false, error: `unexpected message shape: ${preview}` };
  }
  return { ok: true, frame: value };
}
function decodeHostMessage(value) {
  return decode(hostMessageSchema, value);
}

// src/codemode/worker.ts
var MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
function toScriptIdentifier(name) {
  return name.replaceAll(/[^A-Za-z0-9_$]/g, "_").replaceAll(/^(\d)/, "_$1");
}
function discardOutput(memory) {
  return {
    fd_write(_fd, iovsPtr, iovsLen, nwrittenPtr) {
      const view = new DataView(memory.buffer);
      let written = 0;
      for (let index = 0; index < iovsLen; index++) {
        written += view.getUint32(iovsPtr + index * 8 + 4, true);
      }
      view.setUint32(nwrittenPtr, written, true);
      return 0;
    }
  };
}
function post(message) {
  parentPort?.postMessage(message);
}
function emptyWrites() {
  return { set: {}, delete: [] };
}
function parseWrites(json) {
  try {
    const entries = JSON.parse(json);
    const writes = { set: {}, delete: [] };
    for (const [key, value] of entries) {
      if (value === void 0) {
        writes.delete.push(key);
      } else {
        writes.set[key] = JSON.parse(value);
      }
    }
    return writes;
  } catch {
    return emptyWrites();
  }
}
function scriptError(payload, kind) {
  if (payload === void 0) {
    return { kind, message: "the script failed without an error message" };
  }
  try {
    const parsed = JSON.parse(payload);
    return { kind, name: parsed.name, message: parsed.message ?? payload, stack: parsed.stack };
  } catch {
    return { kind, message: payload };
  }
}
async function runScript(wasm, start) {
  const port = parentPort;
  if (!port) {
    return;
  }
  const vm = await QuickJS.create({
    wasm,
    memoryLimit: MEMORY_LIMIT_BYTES,
    // 没有这个上限时深递归会打穿 wasm 栈变成 trap，而不是脚本里可捕获的 RangeError
    maxStackSize: MAX_STACK_SIZE,
    wasi: discardOutput
  });
  const bridge = vm.newFunction(
    "bridge",
    (kind, a, b, c) => {
      const stringOr = (value, fallback) => value === void 0 || value.isUndefined ? fallback : value.toString();
      switch (kind.toString()) {
        case "call": {
          post({
            t: "call",
            id: a.toNumber(),
            name: stringOr(b, ""),
            args: c === void 0 || c.isUndefined ? void 0 : JSON.parse(c.toString())
          });
          break;
        }
        case "output": {
          post({
            t: "output",
            items: a.toString() === "image" ? [
              {
                type: "image",
                data: stringOr(b, ""),
                mimeType: stringOr(c, "application/octet-stream")
              }
            ] : [{ type: "text", text: stringOr(b, "") }]
          });
          break;
        }
        case "done": {
          const writes = c === void 0 || c.isUndefined ? emptyWrites() : parseWrites(c.toString());
          if (a.toBoolean()) {
            post({
              t: "done",
              ok: true,
              value: b === void 0 || b.isUndefined ? void 0 : JSON.parse(b.toString()),
              writes
            });
          } else {
            post({
              t: "done",
              ok: false,
              error: scriptError(b === void 0 ? void 0 : b.toString(), "script"),
              writes
            });
          }
          break;
        }
      }
      return vm.undefined;
    }
  );
  const api = vm.withScope(
    (scope) => scope.escape(
      vm.callFunction(
        vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
        vm.undefined,
        bridge,
        vm.newString(
          JSON.stringify(
            start.tools.map((tool) => ({
              name: tool.name,
              jsName: toScriptIdentifier(tool.name),
              description: tool.description
            }))
          )
        ),
        vm.newString(JSON.stringify(start.store))
      )
    )
  );
  const settle = api.getProp("settle");
  const run = api.getProp("run");
  const stalled = api.getProp("stalled");
  const drain = () => {
    vm.executePendingJobs();
    vm.callFunction(stalled, api).dispose();
  };
  port.on("message", (value) => {
    const message = decodeHostMessage(value);
    if (!message.ok || message.frame.t !== "result") {
      return;
    }
    const result = message.frame;
    try {
      vm.withScope(() => {
        vm.callFunction(
          settle,
          api,
          vm.newNumber(result.id),
          result.ok ? vm.true : vm.false,
          result.ok ? result.value === void 0 ? vm.undefined : vm.newString(JSON.stringify(result.value)) : vm.newString(result.error)
        );
      });
    } catch {
    }
    drain();
  });
  try {
    const fn = vm.evalCode(
      `(async (tools, console) => {${start.code}
})`,
      "codemode.js"
    );
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
          "script"
        ),
        writes: emptyWrites()
      });
    } else {
      post({
        t: "done",
        ok: false,
        error: { kind: "sandbox", message: error instanceof Error ? error.message : String(error) },
        writes: emptyWrites()
      });
    }
  }
}
function main() {
  const port = parentPort;
  if (!port) {
    return;
  }
  const { wasm } = workerData;
  port.once("message", (value) => {
    const message = decodeHostMessage(value);
    if (!message.ok || message.frame.t !== "start") {
      post({
        t: "done",
        ok: false,
        error: { kind: "sandbox", message: "codemode worker: expected a start message first" },
        writes: emptyWrites()
      });
      return;
    }
    void runScript(wasm, message.frame);
  });
}
main();
export {
  toScriptIdentifier
};
