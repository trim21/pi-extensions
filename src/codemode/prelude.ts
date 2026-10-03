/**
 * codemode 脚本侧的 prelude：在 QuickJS VM 里先于脚本求值，构建脚本能看到的全部
 * 能力（`call` / `CallFailedError` / `ALL_TOOLS` / `text` / `image` / `exit` /
 * `console` / `store`），并把宿主桥接封在闭包里——脚本拿不到 `bridge` 本身。
 *
 * 值与参数过桥时都是 JSON 文本，本侧负责 parse/stringify；异步调用用一个 pending
 * 表把 id 映射到 promise，由宿主在结果到达时 settle。每次嵌套调用失败都由宿主以
 * `ok: false` 回报，本侧统一 reject 成 `CallFailedError`（脚本可以按 instanceof 区分
 * 「工具失败」与自己的运行期错误）。
 *
 * 求值结果是一个函数 `(bridge, toolsJson, storeJson) => { settle, run, stalled }`。
 * `bridge(kind, a, b, c)`：
 * - `"call"`（id, name, argsJson）
 * - `"output"`（"text", text）/（"image", data, mimeType）
 * - `"done"`（ok, valueJsonOrErrorJson, writesJson）
 */

/** `store.set()` 单个值的 JSON 上限（字符数）。 */
export const MAX_STORE_VALUE_CHARS = 256 * 1024;
/** 全部 store 值的 JSON 上限（字符数）。 */
export const MAX_STORE_TOTAL_CHARS = 1024 * 1024;

const IMAGE_HELPER_EXPECTS =
  "image expects a non-empty image URL string, an object with image_url, or a raw MCP image block";

export const PRELUDE_SOURCE = String.raw`(function (bridge, toolsJson, storeJson) {
	"use strict";
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const promiseThen = Promise.prototype.then;
	const ErrorCtor = Error;
	const TypeErrorCtor = TypeError;
	// 嵌套调用失败统一用它 reject：脚本能按 instanceof 区分「工具失败」与自身运行期错误
	class CallFailedError extends ErrorCtor {
		constructor(message) {
			super(message);
			this.name = "CallFailedError";
		}
	}
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

	const callers = new Map();
	const allTools = [];
	for (const { name, description } of parse(toolsJson)) {
		if (callers.has(name)) continue;
		callers.set(name, caller(name));
		allTools.push(Object.freeze({ name, description }));
	}
	Object.freeze(allTools);

	function call(name, args) {
		const fn = callers.get(name);
		if (fn === undefined) {
			return Promise.reject(
				new CallFailedError('Tool "' + String(name) + '" is not available in codemode.'),
			);
		}
		return fn(args);
	}
	Object.freeze(call);

	// key -> JSON 文本；容量按 key 与 JSON 的字符数计
	const stored = new Map();
	const writes = new Map();
	let storedChars = 0;
	for (const [key, value] of Object.entries(parse(storeJson))) {
		const json = stringify(value);
		if (json === undefined) continue;
		stored.set(key, json);
		storedChars += key.length + json.length;
	}

	function checkKey(name, key) {
		if (typeof key !== "string") throw new TypeErrorCtor(name + "() key must be a string");
	}

	// 脚本侧是一个键值表：store.set / store.get / store.list，数据本身留在闭包里
	const store = Object.freeze({
		set(key, value) {
			checkKey("store.set", key);
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
				throw new TypeErrorCtor("store.set(" + stringify(key) + ") value is not JSON-serializable: " + format(error));
			}
			if (json === undefined) {
				throw new TypeErrorCtor("store.set(" + stringify(key) + ") value is not JSON-serializable");
			}
			if (json.length > ${MAX_STORE_VALUE_CHARS}) {
				throw new RangeError("store.set(" + stringify(key) + ") value exceeds ${MAX_STORE_VALUE_CHARS} characters of JSON");
			}
			const next = storedChars - previous + key.length + json.length;
			if (next > ${MAX_STORE_TOTAL_CHARS}) {
				throw new RangeError("store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON");
			}
			stored.set(key, json);
			storedChars = next;
			writes.set(key, json);
		},
		get(key) {
			checkKey("store.get", key);
			const json = stored.get(key);
			return json === undefined ? undefined : parse(json);
		},
		// 升序返回当前键：上下文压缩后模型可以靠它找回自己写过的名字
		list() {
			return Array.from(stored.keys()).sort();
		},
	});

	function serializeWrites() {
		const entries = [];
		for (const [key, json] of writes) entries.push(json === undefined ? [key] : [key, json]);
		return stringify(entries);
	}

	Object.defineProperty(globalThis, "store", { value: store, enumerable: true });

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

	Object.defineProperty(globalThis, "call", { value: call, enumerable: true });
	Object.defineProperty(globalThis, "CallFailedError", { value: CallFailedError, enumerable: true });
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
				entry.reject(new CallFailedError(payload));
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
				promise = fn();
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
