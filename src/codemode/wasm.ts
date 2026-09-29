/**
 * `quickjs.wasm` 的编译：codemode 注册工具时做一次，得到 `WebAssembly.Module`，之后
 * 每次执行把它交给 worker 实例化 VM —— 编译只发生一次，不是每次执行都付出。
 *
 * wasm 由 `quickjs-wasi` 包分发（vercel-labs 的 QuickJS-NG wasi 构建），这里只负责
 * 读文件并编译。
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

interface WebAssemblyGlobal {
  compile(bytes: Uint8Array): Promise<object>;
}

export async function compileQuickJSWasm(): Promise<object> {
  const resolved = createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
  const { WebAssembly } = globalThis as unknown as { WebAssembly: WebAssemblyGlobal };
  return await WebAssembly.compile(await readFile(resolved));
}
