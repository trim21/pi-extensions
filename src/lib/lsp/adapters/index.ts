import { ClangdAdapter } from "./clangd.js";
import { PyrightAdapter } from "./pyright.js";
import { RuffAdapter } from "./ruff.js";
import { TypescriptAdapter } from "./typescript.js";

export type { LspServerAdapter, LspServerHandle } from "../adapter.js";

/** 组装启用的服务器列表（新增语言：实现 adapter 后在这里注册）。 */
export function createAdapters() {
  return [new TypescriptAdapter(), new PyrightAdapter(), new RuffAdapter(), new ClangdAdapter()];
}
